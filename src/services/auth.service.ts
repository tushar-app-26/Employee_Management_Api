import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AppDataSource } from "../config/database.js";
import { config } from "../config/config.js";
import { AppError } from "../errors/app-error.js";
import { userRepository } from "../repositories/user.repository.js";
import { listActiveSessions, refreshTokenRepository } from "../repositories/refresh-token.repository.js";
import type { PaginationQuery } from "../validators/pagination.validator.js";
import { RefreshTokenEntity } from "../entities/refresh-token.entity.js";
import { UserEntity } from "../entities/user.entity.js";
import { sessionService } from "./session.service.js";
import { redisCoordinationService } from "./redis-coordination.service.js";
import { sessionLifecycleService } from "./session-lifecycle.service.js";

import type {
    RegisterInput,
    LoginInput,
    ChangePasswordInput,
} from "../validators/auth.validator.js";

const accessTtlFactors: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const accessTtl = /^([1-9]\d*)([smhd])$/.exec(config.JWT_ACCESS_TTL)!;
const ACCESS_TOKEN_SECONDS = Number(accessTtl[1]) * accessTtlFactors[accessTtl[2]!];
const REFRESH_TOKEN_DAYS = config.REFRESH_TOKEN_TTL_DAYS;
// Fixed cost-12 bcrypt hash used so missing accounts still incur a password
// comparison. Its source password is not used for authentication.
const DUMMY_PASSWORD_HASH = "$2b$12$BRbbyWq4p7LMOIzb1QZSaukwQf3HelVXOZRmAKMTheM36m2BjZuz6";

function isUniqueConstraintViolation(error: unknown): boolean {
    const candidate = error as {
        code?: unknown;
        driverError?: { code?: unknown };
    };
    return candidate?.code === "23505" || candidate?.driverError?.code === "23505";
}

export class AuthService {
    private hashToken(token: string): string {
        return createHash("sha256").update(token).digest("hex");
    }

    private createAccessToken(user: {
        id: string;
        role: string;
    }, familyId: string): string {
        return jwt.sign(
            { sub: user.id, role: user.role, sid: familyId },
            config.JWT_SECRET,
            {
                expiresIn: config.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"],
                issuer: "employee-management-api",
                audience: "employee-management-client",
            },
        );
    }

    private async createRefreshToken(userId: string, familyId = randomUUID()) {
        const token = randomBytes(48).toString("base64url");
        const expiresAt = new Date(
            Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
        );

        const record = refreshTokenRepository.create({
            userId,
            familyId,
            tokenHash: this.hashToken(token),
            expiresAt,
            revokedAt: null,
        });

        await refreshTokenRepository.save(record);

        return { token, expiresAt };
    }

    async register(input: RegisterInput): Promise<void> {
        const email = input.email.toLowerCase();
        // Perform the same cost-12 bcrypt work for existing and new addresses
        // before returning the same public response.
        const passwordHash = await bcrypt.hash(input.password, 12);
        const existingUser = await userRepository.findOneBy({ email });

        if (existingUser) return;

        const user = userRepository.create({
            firstName: input.firstName,
            lastName: input.lastName,
            email,
            passwordHash,
            role: "employee",
        });

        try {
            await userRepository.save(user);
        } catch (error) {
            // Handle concurrent registrations that race past the lookup too.
            // A unique-email conflict has the same externally visible result.
            if (!isUniqueConstraintViolation(error)) throw error;
        }
    }


async login(input: LoginInput, correlationId?: string) {
    const email = input.email.toLowerCase();

    const user = await userRepository
        .createQueryBuilder("user")
        .addSelect("user.passwordHash")
        .where("user.email = :email", { email })
        .getOne();

    const failureIdentity = user?.id
        ?? createHash("sha256").update(email).digest("hex");
    const failureKey = `login-failures:${failureIdentity}`;
    const failedAttempts = await redisCoordinationService.getCounter(failureKey);

    if (failedAttempts !== undefined && failedAttempts >= config.LOGIN_FAILURE_LIMIT) {
        throw new AppError(
            429,
            "Too many failed login attempts. Try again later.",
            "LOGIN_TEMPORARILY_LOCKED",
        );
    }

    const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await bcrypt.compare(
        input.password,
        passwordHash,
    );

    if (!user || !user.isActive || !passwordMatches) {
        await redisCoordinationService.incrementLoginFailureCounter(
            failureKey,
            config.LOGIN_FAILURE_TTL_SECONDS,
            config.LOGIN_FAILURE_LIMIT,
        );
        throw new AppError(401, "Invalid email or password");
    }

    await redisCoordinationService.deleteKey(failureKey);

    const familyId = randomUUID();

    const refreshTokenRecord = await this.createRefreshToken(
        user.id,
        familyId,
    );
    const refreshToken = refreshTokenRecord.token;

    const accessToken = this.createAccessToken(
        user,
        familyId,
    );

    try {
        await sessionService.create(
            familyId,
            user.id,
            REFRESH_TOKEN_DAYS * 24 * 60 * 60,
            refreshTokenRecord.expiresAt,
        );
        const tokenHash = this.hashToken(refreshToken);
        await sessionService.storeRefreshTokenMetadata({
            tokenHash,
            userId: user.id,
            sessionId: familyId,
            expiresAt: refreshTokenRecord.expiresAt,
        });
        await sessionLifecycleService.record({
            eventKey: `SESSION_CREATED:${familyId}`,
            userId: user.id,
            sessionId: familyId,
            eventType: "SESSION_CREATED",
            correlationId,
        });
    } catch (error) {
        // Do not leave a valid refresh token if Redis session creation fails.
        await refreshTokenRepository
            .createQueryBuilder()
            .update(RefreshTokenEntity)
            .set({ revokedAt: new Date() })
            .where('"family_id" = :familyId', { familyId })
            .andWhere('"revoked_at" IS NULL')
            .execute();
        await sessionService.removeSafely([familyId]);

        throw error;
    }

    return {
        user: {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            role: user.role,
        },
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        expiresIn: ACCESS_TOKEN_SECONDS,
        refreshTokenExpiresIn:
            REFRESH_TOKEN_DAYS * 24 * 60 * 60,
    };
}


    async refresh(token: string, correlationId?: string) {
        const tokenHash = this.hashToken(token);
        const replacementToken = randomBytes(48).toString("base64url");
        const replacementExpiry = new Date(
            Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
        );

        let invalidatedFamilyId: string | null = null;
        let revokedAt: Date | null = null;
        let refreshedFamilyId: string | null = null;
        let refreshedUserId: string | null = null;
        const refreshed = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(RefreshTokenEntity);
            const existing = await repository.findOne({
                where: { tokenHash },
                lock: { mode: "pessimistic_write" },
            });

            if (!existing) {
                return null;
            }

            if (existing.revokedAt) {
                // Reuse of a rotated/revoked token revokes the remaining
                // active token in that login session (token family).
                await repository
                    .createQueryBuilder()
                    .update(RefreshTokenEntity)
                    .set({ revokedAt: new Date() })
                    .where('"family_id" = :familyId', { familyId: existing.familyId })
                    .andWhere('"revoked_at" IS NULL')
                    .execute();
                invalidatedFamilyId = existing.familyId;
                revokedAt = new Date();
                await sessionLifecycleService.record({
                    eventKey: `REFRESH_TOKEN_REUSE_DETECTED:${existing.familyId}:${tokenHash}`,
                    userId: existing.userId,
                    sessionId: existing.familyId,
                    eventType: "REFRESH_TOKEN_REUSE_DETECTED",
                    correlationId,
                    details: { tokenHashPrefix: tokenHash.slice(0, 12) },
                }, manager);
                return null;
            }
            if (existing.expiresAt.getTime() <= Date.now()) return null;

            existing.revokedAt = new Date();
            await repository.save(existing);

            const user = await manager.getRepository(UserEntity).findOneBy({
                id: existing.userId,
            });
            if (!user || !user.isActive) {
                throw new AppError(401, "Invalid or expired refresh token");
            }

            if (!(await sessionService.exists(existing.familyId, existing.userId))) {
                throw new AppError(401, "Invalid or expired refresh token");
            }
            refreshedFamilyId = existing.familyId;
            refreshedUserId = existing.userId;

            const replacement = repository.create({
                userId: existing.userId,
                familyId: existing.familyId,
                tokenHash: this.hashToken(replacementToken),
                expiresAt: replacementExpiry,
                revokedAt: null,
            });
            await repository.save(replacement);

            return {
                accessToken: this.createAccessToken(user, existing.familyId),
                refreshToken: replacementToken,
                tokenType: "Bearer",
                expiresIn: ACCESS_TOKEN_SECONDS,
                refreshTokenExpiresIn: REFRESH_TOKEN_DAYS * 24 * 60 * 60,
            };
        });

        if (!refreshed) {
            if (invalidatedFamilyId && revokedAt) {
                await sessionService.markRefreshTokenRevoked(tokenHash, revokedAt).catch(() => undefined);
            }
            if (invalidatedFamilyId) {
                await sessionService.removeSafely([invalidatedFamilyId]);
            }
            throw new AppError(401, "Invalid or expired refresh token");
        }

        try {
            await sessionService.markRefreshTokenRevoked(tokenHash, new Date());
            await sessionService.storeRefreshTokenMetadata({
                tokenHash: this.hashToken(refreshed.refreshToken),
                userId: refreshedUserId!,
                sessionId: refreshedFamilyId!,
                expiresAt: replacementExpiry,
            });
            await sessionService.extend(refreshedFamilyId!, replacementExpiry);
        } catch (error) {
            await AppDataSource.transaction(async (manager) => {
                await manager.getRepository(RefreshTokenEntity).createQueryBuilder()
                    .update(RefreshTokenEntity)
                    .set({ revokedAt: new Date() })
                    .where('"family_id" = :familyId', { familyId: refreshedFamilyId })
                    .andWhere('"revoked_at" IS NULL')
                    .execute();
                await sessionLifecycleService.record({
                    eventKey: `SESSION_REVOKED:${refreshedFamilyId}`,
                    userId: refreshedUserId,
                    sessionId: refreshedFamilyId!,
                    eventType: "SESSION_REVOKED",
                    correlationId,
                    details: { reason: "refresh_rotation_store_failure" },
                }, manager);
            }).catch((auditError: unknown) => {
                console.error("Could not persist session revocation after refresh-store failure", {
                    sessionId: refreshedFamilyId,
                    correlationId,
                    error: auditError,
                });
            });
            await sessionService.removeSafely([refreshedFamilyId!]);
            throw error;
        }

        return refreshed;
    }

    async logout(token: string, correlationId?: string) {
        const tokenHash = this.hashToken(token);

        const existing = await refreshTokenRepository.findOneBy({
            tokenHash,
        });

        if (existing) {
            await AppDataSource.transaction(async (manager) => {
                await manager.getRepository(RefreshTokenEntity)
                    .createQueryBuilder()
                    .update(RefreshTokenEntity)
                    .set({ revokedAt: new Date() })
                    .where('"family_id" = :familyId', { familyId: existing.familyId })
                    .andWhere('"revoked_at" IS NULL')
                    .execute();
                await sessionLifecycleService.record({
                    eventKey: `LOGOUT:${existing.familyId}`,
                    userId: existing.userId,
                    sessionId: existing.familyId,
                    eventType: "LOGOUT",
                    correlationId,
                }, manager);
            });
            await sessionService.markRefreshTokenRevoked(tokenHash, new Date()).catch(() => undefined);
            await sessionService.removeSafely([existing.familyId]);
        }

        return { loggedOut: true };
    }

    async logoutAll(userId: string, correlationId?: string) {
        const result = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(RefreshTokenEntity);
            const active: Array<{ family_id: string }> = await repository.query(
                `SELECT DISTINCT family_id
                 FROM refresh_tokens
                 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
                [userId],
            );
            await repository.createQueryBuilder()
                .update(RefreshTokenEntity)
                .set({ revokedAt: new Date() })
                .where('"user_id" = :userId', { userId })
                .andWhere('"revoked_at" IS NULL')
                .execute();
            for (const row of active) {
                await sessionLifecycleService.record({
                    eventKey: `LOGOUT:${row.family_id}`,
                    userId,
                    sessionId: row.family_id,
                    eventType: "LOGOUT",
                    correlationId,
                }, manager);
            }
            return { familyIds: active.map((row) => row.family_id), revokedSessions: active.length };
        });

        await sessionService.removeSafely(result.familyIds);
        return { revokedSessions: result.revokedSessions };
    }

    async getActiveSessions(userId: string, pagination: PaginationQuery) {
        return listActiveSessions(userId, pagination.page, pagination.limit);
    }

    async getSessionHistory(userId: string, pagination: PaginationQuery) {
        return sessionLifecycleService.getUserHistory(userId, pagination.page, pagination.limit);
    }

    async getActiveSession(userId: string, sessionFamilyId: string) {
        // The API's session `id` is the refresh-token family ID. The
        // refresh_tokens primary key identifies an individual rotation row.
        const sessions = await refreshTokenRepository.query(
            `SELECT family_id AS id,
                    MAX(created_at) AS "createdAt",
                    MAX(expires_at) AS "expiresAt"
             FROM refresh_tokens
             WHERE user_id = $1
               AND family_id = $2
               AND revoked_at IS NULL
               AND expires_at > NOW()
             GROUP BY family_id`,
            [userId, sessionFamilyId],
        );

        return sessions[0] ?? null;
    }

    async revokeSession(userId: string, sessionFamilyId: string, correlationId?: string) {
        const revoked = await AppDataSource.transaction(async (manager) => {
            const result = await manager.getRepository(RefreshTokenEntity)
                .createQueryBuilder()
                .update(RefreshTokenEntity)
                .set({ revokedAt: new Date() })
                .where('"family_id" = :sessionFamilyId', { sessionFamilyId })
                .andWhere('"user_id" = :userId', { userId })
                .andWhere('"revoked_at" IS NULL')
                .execute();
            const wasRevoked = (result.affected ?? 0) > 0;
            if (wasRevoked) await sessionLifecycleService.record({
                eventKey: `SESSION_REVOKED:${sessionFamilyId}`,
                userId,
                sessionId: sessionFamilyId,
                eventType: "SESSION_REVOKED",
                correlationId,
            }, manager);
            return wasRevoked;
        });
        if (revoked) await sessionService.removeSafely([sessionFamilyId]);
        return revoked;
    }

    async changePassword(userId: string, input: ChangePasswordInput, correlationId?: string) {
        const user = await userRepository
            .createQueryBuilder("user")
            .addSelect("user.passwordHash")
            .where("user.id = :userId", { userId })
            .getOne();

        if (!user) {
            throw new AppError(404, "User not found");
        }

        if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
            throw new AppError(400, "Current password is incorrect");
        }

        user.passwordHash = await bcrypt.hash(input.newPassword, 12);

        const familyIds = await AppDataSource.transaction(async (manager) => {
            await manager.getRepository(UserEntity).save(user);
            const active: Array<{ family_id: string }> = await manager.query(
                `SELECT DISTINCT family_id FROM refresh_tokens
                 WHERE user_id = $1 AND revoked_at IS NULL`,
                [userId],
            );
            await manager
                .getRepository(RefreshTokenEntity)
                .createQueryBuilder()
                .update(RefreshTokenEntity)
                .set({ revokedAt: new Date() })
                .where('"user_id" = :userId', { userId })
                .andWhere('"revoked_at" IS NULL')
                .execute();
            for (const row of active) await sessionLifecycleService.record({
                eventKey: `SESSION_REVOKED:${row.family_id}`,
                userId,
                sessionId: row.family_id,
                eventType: "SESSION_REVOKED",
                correlationId,
                details: { reason: "password_changed" },
            }, manager);
            return active.map((row) => row.family_id);
        });
        await sessionService.removeSafely(familyIds);

        return { passwordChanged: true, sessionsRevoked: true };
    }
}

export const authService = new AuthService();
