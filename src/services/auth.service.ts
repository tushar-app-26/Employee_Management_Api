import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AppDataSource } from "../config/database.js";
import { config } from "../config/config.js";
import { AppError } from "../errors/app-error.js";
import { userRepository } from "../repositories/user.repository.js";
import { refreshTokenRepository } from "../repositories/refresh-token.repository.js";
import { RefreshTokenEntity } from "../entities/refresh-token.entity.js";
import { UserEntity } from "../entities/user.entity.js";

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

        return token;
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

    async login(input: LoginInput) {
        const email = input.email.toLowerCase();

        const user = await userRepository
            .createQueryBuilder("user")
            .addSelect("user.passwordHash")
            .where("user.email = :email", { email })
            .getOne();

        const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
        const passwordMatches = await bcrypt.compare(input.password, passwordHash);

        if (!user || !user.isActive || !passwordMatches) {
            throw new AppError(401, "Invalid email or password");
        }

        const familyId = randomUUID();
        const refreshToken = await this.createRefreshToken(user.id, familyId);
        const accessToken = this.createAccessToken(user, familyId);

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
            refreshTokenExpiresIn: REFRESH_TOKEN_DAYS * 24 * 60 * 60,
        };
    }

    async refresh(token: string) {
        const tokenHash = this.hashToken(token);
        const replacementToken = randomBytes(48).toString("base64url");
        const replacementExpiry = new Date(
            Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
        );

        const refreshed = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(RefreshTokenEntity);
            const existing = await repository.findOne({
                where: { tokenHash },
                lock: { mode: "pessimistic_write" },
            });

            if (!existing) {
                return null;
            }

            if (
                existing.revokedAt ||
                existing.expiresAt.getTime() <= Date.now()
            ) {
                // Reuse of a rotated/revoked token revokes the remaining
                // active token in that login session (token family).
                await repository
                    .createQueryBuilder()
                    .update(RefreshTokenEntity)
                    .set({ revokedAt: new Date() })
                    .where('"family_id" = :familyId', { familyId: existing.familyId })
                    .andWhere('"revoked_at" IS NULL')
                    .execute();
                return null;
            }

            existing.revokedAt = new Date();
            await repository.save(existing);

            const user = await manager.getRepository(UserEntity).findOneBy({
                id: existing.userId,
            });
            if (!user || !user.isActive) {
                throw new AppError(401, "Invalid or expired refresh token");
            }

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
            throw new AppError(401, "Invalid or expired refresh token");
        }

        return refreshed;
    }

    async logout(token: string) {
        const tokenHash = this.hashToken(token);

        const existing = await refreshTokenRepository.findOneBy({
            tokenHash,
        });

        if (existing) {
            await refreshTokenRepository
                .createQueryBuilder()
                .update(RefreshTokenEntity)
                .set({ revokedAt: new Date() })
                .where('"family_id" = :familyId', { familyId: existing.familyId })
                .andWhere('"revoked_at" IS NULL')
                .execute();
        }

        return { loggedOut: true };
    }

    async logoutAll(userId: string) {
        const revokedSessions = await AppDataSource.transaction(async (manager) => {
            const repository = manager.getRepository(RefreshTokenEntity);
            const active: Array<{ count: string }> = await repository.query(
                `SELECT COUNT(DISTINCT family_id)::text AS count
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
            return Number(active[0]?.count ?? 0);
        });

        return { revokedSessions };
    }

    async getActiveSessions(userId: string) {
        return refreshTokenRepository.query(
            `SELECT family_id AS id,
                    MAX(created_at) AS "createdAt",
                    MAX(expires_at) AS "expiresAt"
             FROM refresh_tokens
             WHERE user_id = $1
               AND revoked_at IS NULL
               AND expires_at > NOW()
             GROUP BY family_id
             ORDER BY MAX(created_at) DESC`,
            [userId],
        );
    }

    async getActiveSession(userId: string, sessionId: string) {
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
            [userId, sessionId],
        );

        return sessions[0] ?? null;
    }

    async revokeSession(userId: string, sessionId: string) {
        const result = await refreshTokenRepository
            .createQueryBuilder()
            .update(RefreshTokenEntity)
            .set({ revokedAt: new Date() })
            .where('"family_id" = :sessionId', { sessionId })
            .andWhere('"user_id" = :userId', { userId })
            .andWhere('"revoked_at" IS NULL')
            .execute();

        return (result.affected ?? 0) > 0;
    }

    async changePassword(userId: string, input: ChangePasswordInput) {
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

        await AppDataSource.transaction(async (manager) => {
            await manager.getRepository(UserEntity).save(user);
            await manager
                .getRepository(RefreshTokenEntity)
                .createQueryBuilder()
                .update(RefreshTokenEntity)
                .set({ revokedAt: new Date() })
                .where('"user_id" = :userId', { userId })
                .andWhere('"revoked_at" IS NULL')
                .execute();
        });

        return { passwordChanged: true, sessionsRevoked: true };
    }
}

export const authService = new AuthService();
