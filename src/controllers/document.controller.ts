import type { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../utils/api-response.js";
import { documentService } from "../services/document.service.js";
import type { PaginationQuery } from "../validators/pagination.validator.js";

export class DocumentController {
    async upload(req: Request, res: Response, next: NextFunction) {
        try {
            const data = await documentService.upload(
                req.params.id as string,
                req.file,
                req.auth!,
                String(res.locals.requestId ?? ""),
            );
            ApiResponse.send(res, 201, "Employee document uploaded successfully", data);
        } catch (error) { next(error); }
    }

    async list(req: Request, res: Response, next: NextFunction) {
        try {
            const data = await documentService.list(
                req.params.id as string,
                req.auth!,
                res.locals.validatedQuery as PaginationQuery,
            );
            ApiResponse.send(res, 200, "Employee documents fetched successfully", data);
        } catch (error) { next(error); }
    }

    async createDownloadUrl(req: Request, res: Response, next: NextFunction) {
        try {
            const data = await documentService.createDownloadUrl(
                req.params.id as string,
                req.auth!,
                String(res.locals.requestId ?? ""),
            );
            ApiResponse.send(res, 200, "Short-lived document download link created", data);
        } catch (error) { next(error); }
    }

    async download(req: Request, res: Response, next: NextFunction) {
        try {
            const file = await documentService.download(req.params.id as string, req.query.token as string | undefined);
            if ("redirectUrl" in file) {
                res.setHeader("Cache-Control", "private, no-store");
                res.redirect(302, file.redirectUrl);
                return;
            }
            res.setHeader("Content-Type", file.mimeType);
            res.setHeader("Cache-Control", "private, no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.download(file.path, file.filename, (error) => { if (error && !res.headersSent) next(error); });
        } catch (error) { next(error); }
    }

    async delete(req: Request, res: Response, next: NextFunction) {
        try {
            const deleted = await documentService.delete(
                req.params.id as string,
                req.auth!,
                String(res.locals.requestId ?? ""),
            );
            if (!deleted) {
                ApiResponse.send(res, 404, "Document not found", null);
                return;
            }
            ApiResponse.send(res, 200, "Employee document deleted successfully", null);
        } catch (error) { next(error); }
    }
}

export const documentController = new DocumentController();
