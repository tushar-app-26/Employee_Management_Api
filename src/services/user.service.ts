import { EmployeeEntity } from "../entities/employee.entity.js";
import { UserEntity, type UserRole } from "../entities/user.entity.js";
import { RefreshTokenEntity } from "../entities/refresh-token.entity.js";
import { AppDataSource } from "../config/database.js";
import { AppError } from "../errors/app-error.js";
import { auditService } from "./audit.service.js";
import { listUnlinkedEmployeeUsers, userRepository } from "../repositories/user.repository.js";
import type { PaginationQuery } from "../validators/pagination.validator.js";
import { sessionLifecycleService } from "./session-lifecycle.service.js";

export class UserService {
    async getUnlinkedEmployeeUsers(pagination: PaginationQuery) {
        return listUnlinkedEmployeeUsers(pagination.page, pagination.limit);
    }

    async updateAccess(
        targetUserId: string,
        input: { role?: UserRole; isActive?: boolean },
        actorUserId: string,
        requestId?: string,
    ) {
        if (targetUserId === actorUserId && input.role !== undefined) {
            throw new AppError(400, "Administrators cannot change their own role");
        }
        if (targetUserId === actorUserId && input.isActive === false) {
            throw new AppError(400, "Administrators cannot deactivate their own account");
        }

        return AppDataSource.transaction(async (manager) => {
            const users = manager.getRepository(UserEntity);
            const target = await users.findOneBy({ id: targetUserId });
            if (!target) return null;

            const removingAdminAccess = target.role === "admin" &&
                ((input.role !== undefined && input.role !== "admin") || input.isActive === false);
            if (removingAdminAccess) {
                const activeAdmins: Array<{ id: string }> = await manager.query(
                    "SELECT id FROM users WHERE role_id = 'admin' AND is_active = TRUE FOR UPDATE",
                );
                if (activeAdmins.length <= 1) {
                    throw new AppError(400, "The last active administrator cannot be deactivated or demoted");
                }
            }

            if (input.isActive === true) {
                const profile = await manager.getRepository(EmployeeEntity).findOneBy({ userId: targetUserId });
                if (profile && (profile.employmentStatus === "inactive" || profile.employmentStatus === "terminated")) {
                    throw new AppError(400, "Reactivate the employment profile before reactivating this account");
                }
            }

            const before = { role: target.role, isActive: target.isActive };
            if (input.role !== undefined) target.role = input.role;
            if (input.isActive !== undefined) target.isActive = input.isActive;
            await users.save(target);

            if (input.isActive === false || input.role !== undefined) {
                // Role changes invalidate previously issued refresh sessions so
                // the next login receives tokens reflecting the new role.
                const affected: Array<{ family_id: string }> = await manager.query(
                    `SELECT DISTINCT family_id FROM refresh_tokens
                     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
                    [targetUserId],
                );
                await manager.getRepository(RefreshTokenEntity).createQueryBuilder()
                    .update(RefreshTokenEntity)
                    .set({ revokedAt: new Date() })
                    .where('"user_id" = :userId', { userId: targetUserId })
                    .andWhere('"revoked_at" IS NULL')
                    .execute();
                for (const session of affected) await sessionLifecycleService.record({
                    eventKey: `SESSION_REVOKED:${session.family_id}`,
                    userId: targetUserId,
                    sessionId: session.family_id,
                    eventType: "SESSION_REVOKED",
                    correlationId: requestId,
                    details: { reason: input.isActive === false ? "account_deactivated" : "role_changed" },
                }, manager);
            }

            const action = input.role !== undefined ? "user.role_changed"
                : input.isActive === false ? "user.account_deactivated"
                    : "user.account_reactivated";
            await auditService.record({
                actorUserId, action, resourceType: "user", resourceId: targetUserId,
                requestId, details: { before, after: { role: target.role, isActive: target.isActive } },
            }, manager);

            return { id: target.id, firstName: target.firstName, lastName: target.lastName, email: target.email, role: target.role, isActive: target.isActive };
        });
    }

    async revokeAllSessions(targetUserId: string, actorUserId: string, requestId?: string) {
        return AppDataSource.transaction(async (manager) => {
            const user = await manager.getRepository(UserEntity).findOneBy({ id: targetUserId });
            if (!user) return null;
            const activeSessions: Array<{ count: string }> = await manager.query(
                `SELECT COUNT(DISTINCT family_id)::text AS count
                 FROM refresh_tokens
                 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
                [targetUserId],
            );
            const families: Array<{ family_id: string }> = await manager.query(
                `SELECT DISTINCT family_id FROM refresh_tokens
                 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
                [targetUserId],
            );
            await manager.getRepository(RefreshTokenEntity).createQueryBuilder()
                .update(RefreshTokenEntity)
                .set({ revokedAt: new Date() })
                .where('"user_id" = :userId', { userId: targetUserId })
                .andWhere('"revoked_at" IS NULL')
                .execute();
            for (const session of families) await sessionLifecycleService.record({
                eventKey: `SESSION_REVOKED:${session.family_id}`,
                userId: targetUserId,
                sessionId: session.family_id,
                eventType: "SESSION_REVOKED",
                correlationId: requestId,
                details: { reason: "admin_revoked_all_sessions" },
            }, manager);
            await auditService.record({
                actorUserId, action: "user.sessions_revoked", resourceType: "user",
                resourceId: targetUserId, requestId,
                details: { revokedSessions: Number(activeSessions[0]?.count ?? 0) },
            }, manager);
            return { userId: targetUserId, revokedSessions: Number(activeSessions[0]?.count ?? 0) };
        });
    }
}

export const userService = new UserService();
