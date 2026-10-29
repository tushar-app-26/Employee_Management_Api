
import { AppDataSource } from "../config/database.js";
import { RefreshTokenEntity } from "../entities/refresh-token.entity.js";

export const refreshTokenRepository =
    AppDataSource.getRepository(RefreshTokenEntity);

export interface AuthSessionSummary {
    // Public session `id` is familyId; RefreshTokenEntity.id is one rotation row.
    id: string;
    createdAt: Date;
    expiresAt: Date;
}

export async function listActiveSessions(userId: string, page: number, limit: number) {
    const baseQuery = refreshTokenRepository.createQueryBuilder("session")
        .where("session.userId = :userId", { userId })
        .andWhere("session.revokedAt IS NULL")
        .andWhere("session.expiresAt > NOW()");
    const [items, count] = await Promise.all([
        baseQuery.clone()
            .select("session.familyId", "id")
            .addSelect("MAX(session.createdAt)", "createdAt")
            .addSelect("MAX(session.expiresAt)", "expiresAt")
            .groupBy("session.familyId")
            .orderBy("MAX(session.createdAt)", "DESC")
            .offset((page - 1) * limit)
            .limit(limit)
            .getRawMany<AuthSessionSummary>(),
        baseQuery.clone().select("COUNT(DISTINCT session.familyId)", "total").getRawOne<{ total: string }>(),
    ]);
    const total = Number(count?.total ?? 0);
    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
