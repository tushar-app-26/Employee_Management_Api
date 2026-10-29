import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import jwt from "jsonwebtoken";
import { AppDataSource } from "../config/database.js";
import { config } from "../config/config.js";
import { EmployeeDocumentEntity } from "../entities/employee-document.entity.js";
import { EmployeeEntity } from "../entities/employee.entity.js";
import { UserEntity } from "../entities/user.entity.js";
import { AppError } from "../errors/app-error.js";
import type { AuthPayload } from "../middlewares/auth.middleware.js";
import { acceptedTypes, storageDirectory, createStorageFilename } from "../middlewares/document-upload.js";
import { auditService } from "./audit.service.js";
import { documentStorage } from "./document-storage.js";
import type { PaginationQuery } from "../validators/pagination.validator.js";
import { fingerprintJson, redisCoordinationService } from "./redis-coordination.service.js";

const downloadTokenTtlSeconds = 120;

async function assertEmployeeAccess(employeeId: string, actor: AuthPayload, write: boolean) {
    const employee = await AppDataSource.getRepository(EmployeeEntity).findOneBy({ id: employeeId });
    if (!employee) throw new AppError(404, "Employee not found");
    if (actor.role === "admin" || actor.role === "hr") return employee;

    if (actor.role === "manager" && write) {
        const manager = await AppDataSource.getRepository(EmployeeEntity).findOneBy({ userId: actor.sub });
        if (manager && employee.managerId === manager.id && !["inactive", "terminated"].includes(employee.employmentStatus)) return employee;
    } else if (actor.role === "manager") {
        const manager = await AppDataSource.getRepository(EmployeeEntity).findOneBy({ userId: actor.sub });
        if (manager && employee.managerId === manager.id && !["inactive", "terminated"].includes(employee.employmentStatus)) return employee;
    }

    if (actor.role === "employee" && !write && employee.userId === actor.sub) return employee;
    if (actor.role === "employee" && write && employee.userId === actor.sub) return employee;
    throw new AppError(404, "Employee not found");
}

function verifyContent(bytes: Buffer, mimeType: string): boolean {
    return mimeType === "application/pdf"
        ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
        : mimeType === "image/png"
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function safeOriginalFilename(name: string) {
    const clean = basename(name).replace(/[\r\n\0]/g, "").slice(0, 255);
    return clean || "employee-document";
}

export class DocumentService {
    async upload(
        employeeId: string,
        file: Express.Multer.File | undefined,
        actor: AuthPayload,
        requestId?: string,
        idempotencyKey?: string,
    ) {
        const contentHash = file
            ? createHash("sha256").update(file.buffer).digest("hex")
            : "missing-file";
        return redisCoordinationService.runIdempotent({
            scope: `document-upload:${employeeId}`,
            actorId: actor.sub,
            requestKey: idempotencyKey,
            fingerprint: fingerprintJson({
                employeeId,
                originalFilename: file?.originalname,
                mimeType: file?.mimetype,
                size: file?.size,
                contentHash,
            }),
            operation: () => this.uploadOnce(employeeId, file, actor, requestId),
        });
    }

    private async uploadOnce(employeeId: string, file: Express.Multer.File | undefined, actor: AuthPayload, requestId?: string) {
        if (!file) throw new AppError(400, "Attach one file using the 'document' field");
        let employee: EmployeeEntity;
        try {
            employee = await assertEmployeeAccess(employeeId, actor, true);
        } catch (error) {
            // The file is still only in memory at this point; rejected uploads
            // never reach either local disk or object storage.
            throw error;
        }
        const storageFilename = createStorageFilename(file.originalname);
        const expectedType = acceptedTypes[`.${storageFilename.split(".").pop()?.toLowerCase()}`];
        const contentMatches = Boolean(expectedType && verifyContent(file.buffer, expectedType));
        if (!expectedType || expectedType !== file.mimetype || !contentMatches) {
            throw new AppError(400, "The uploaded file content does not match an allowed document type");
        }

        try {
            await documentStorage.put(storageFilename, file.buffer, expectedType);
        } catch (error) {
            console.error("Document storage upload failed", { storageFilename, error });
            throw new AppError(503, "Document storage is temporarily unavailable", "STORAGE_UNAVAILABLE");
        }

        try {
            const record = await AppDataSource.transaction(async (manager) => {
                const document = manager.getRepository(EmployeeDocumentEntity).create({
                    employeeId: employee.id,
                    uploadedByUserId: actor.sub,
                    originalFilename: safeOriginalFilename(file.originalname),
                    storageFilename,
                    mimeType: expectedType,
                    sizeBytes: file.size,
                });
                const saved = await manager.getRepository(EmployeeDocumentEntity).save(document);
                await auditService.record({
                    actorUserId: actor.sub,
                    action: "employee_document.uploaded",
                    resourceType: "employee_document",
                    resourceId: saved.id,
                    requestId,
                    details: { employeeId: employee.id, mimeType: expectedType, sizeBytes: file.size },
                }, manager);
                return saved;
            });
            return this.toResponse(record);
        } catch (error) {
            await documentStorage.delete(storageFilename).catch((cleanupError) => {
                console.error("Document upload cleanup failed", { storageFilename, error: cleanupError });
            });
            throw error;
        }
    }

    async list(employeeId: string, actor: AuthPayload, pagination: PaginationQuery) {
        const employee = await assertEmployeeAccess(employeeId, actor, false);
        const [documents, total] = await AppDataSource.getRepository(EmployeeDocumentEntity).findAndCount({
            where: { employeeId: employee.id }, order: { createdAt: "DESC" },
            skip: (pagination.page - 1) * pagination.limit,
            take: pagination.limit,
        });
        return {
            items: documents.map((document) => this.toResponse(document)),
            pagination: {
                ...pagination,
                total,
                totalPages: Math.ceil(total / pagination.limit),
            },
        };
    }

    async createDownloadUrl(documentId: string, actor: AuthPayload, requestId?: string) {
        const document = await this.getAuthorizedDocument(documentId, actor);
        const linkCount = await redisCoordinationService.incrementDocumentLinkCounter(
            `doc-link-limit:${actor.sub}`,
            config.DOCUMENT_LINK_WINDOW_SECONDS,
            config.DOCUMENT_LINK_LIMIT,
        );
        if (linkCount !== undefined && linkCount > config.DOCUMENT_LINK_LIMIT) {
            throw new AppError(
                429,
                "Too many document download links requested. Try again later.",
                "DOCUMENT_LINK_RATE_LIMITED",
            );
        }

        const presignedUrl = await documentStorage.presignedDownloadUrl(
            document.storageFilename,
            safeOriginalFilename(document.originalFilename),
            document.mimeType,
        );
        await auditService.record({
            actorUserId: actor.sub,
            action: "employee_document.download_link_created",
            resourceType: "employee_document",
            resourceId: document.id,
            requestId,
        });
        if (presignedUrl) {
            return { downloadUrl: presignedUrl, expiresInSeconds: config.S3_PRESIGNED_URL_TTL_SECONDS };
        }
        const token = jwt.sign({ purpose: "employee-document-download", documentId, userId: actor.sub }, config.JWT_SECRET, {
            algorithm: "HS256", expiresIn: downloadTokenTtlSeconds, issuer: "employee-management-api", audience: "employee-document-download",
        });
        return {
            downloadUrl: `/api/v1/documents/${document.id}/download?token=${encodeURIComponent(token)}`,
            expiresInSeconds: downloadTokenTtlSeconds,
        };
    }

    async download(documentId: string, token: string | undefined): Promise<
        { redirectUrl: string } | { path: string; filename: string; mimeType: string }
    > {
        if (!token) throw new AppError(401, "A valid download token is required");
        let decoded: string | jwt.JwtPayload;
        try {
            decoded = jwt.verify(token, config.JWT_SECRET, {
                algorithms: ["HS256"], issuer: "employee-management-api", audience: "employee-document-download",
            });
        } catch {
            throw new AppError(401, "Download link is invalid or expired");
        }
        if (typeof decoded === "string" || decoded.purpose !== "employee-document-download" || decoded.documentId !== documentId || typeof decoded.userId !== "string") {
            throw new AppError(401, "Download link is invalid or expired");
        }
        const user = await AppDataSource.getRepository(UserEntity).findOneBy({ id: decoded.userId });
        if (!user?.isActive) throw new AppError(401, "Download link is invalid or expired");
        const actor = { sub: user.id, role: user.role } as AuthPayload;
        const document = await this.getAuthorizedDocument(documentId, actor);
        const presignedUrl = await documentStorage.presignedDownloadUrl(
            document.storageFilename,
            safeOriginalFilename(document.originalFilename),
            document.mimeType,
        );
        if (presignedUrl) return { redirectUrl: presignedUrl };
        return { path: documentStorage.getLocalPath(document.storageFilename), filename: document.originalFilename, mimeType: document.mimeType };
    }

    async delete(documentId: string, actor: AuthPayload, requestId?: string) {
        if (actor.role !== "admin" && actor.role !== "hr") throw new AppError(403, "You cannot delete employee documents");
        const repository = AppDataSource.getRepository(EmployeeDocumentEntity);
        const document = await repository.findOneBy({ id: documentId });
        if (!document) return false;
        if (documentStorage.usesS3) {
            await AppDataSource.transaction(async (manager) => {
                await manager.getRepository(EmployeeDocumentEntity).delete({ id: document.id });
                await auditService.record({
                    actorUserId: actor.sub,
                    action: "employee_document.deleted",
                    resourceType: "employee_document",
                    resourceId: document.id,
                    requestId,
                    details: { employeeId: document.employeeId, mimeType: document.mimeType },
                }, manager);
            });
            try {
                await documentStorage.delete(document.storageFilename);
            } catch (error) {
                console.error("S3 document cleanup failed after metadata deletion", { documentId: document.id, error });
            }
            return true;
        }
        const filePath = resolve(storageDirectory, document.storageFilename);
        const pendingDeletePath = resolve(storageDirectory, `.pending-delete-${document.id}`);
        let stagedForDelete = false;
        try {
            await rename(filePath, pendingDeletePath);
            stagedForDelete = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AppError(503, "Document storage is temporarily unavailable", "STORAGE_UNAVAILABLE");
        }
        try {
            await AppDataSource.transaction(async (manager) => {
                await manager.getRepository(EmployeeDocumentEntity).delete({ id: document.id });
                await auditService.record({
                    actorUserId: actor.sub,
                    action: "employee_document.deleted",
                    resourceType: "employee_document",
                    resourceId: document.id,
                    requestId,
                    details: { employeeId: document.employeeId, mimeType: document.mimeType },
                }, manager);
            });
        } catch (error) {
            if (stagedForDelete) {
                await rename(pendingDeletePath, filePath).catch(() => {
                    console.error("Document delete rollback could not restore local file", document.id);
                });
            }
            throw error;
        }
        if (stagedForDelete) await unlink(pendingDeletePath).catch(() => {
            // The private pending-delete file is an orphan and can be removed during operational cleanup.
            console.error("Private document cleanup required", document.id);
        });
        return true;
    }

    private async getAuthorizedDocument(documentId: string, actor: AuthPayload) {
        const document = await AppDataSource.getRepository(EmployeeDocumentEntity).findOneBy({ id: documentId });
        if (!document) throw new AppError(404, "Document not found");
        await assertEmployeeAccess(document.employeeId, actor, false);
        return document;
    }

    private toResponse(document: EmployeeDocumentEntity) {
        return {
            id: document.id,
            employeeId: document.employeeId,
            originalFilename: document.originalFilename,
            mimeType: document.mimeType,
            sizeBytes: document.sizeBytes,
            createdAt: document.createdAt,
        };
    }
}

export const documentService = new DocumentService();
