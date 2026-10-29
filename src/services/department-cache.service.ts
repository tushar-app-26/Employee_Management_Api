import {
    connectRateLimitRedis,
    rateLimitRedisClient,
} from "../config/rate-limit-store.js";
import type { DepartmentEntity } from "../entities/department.entity.js";

export const DEPARTMENT_LIST_CACHE_KEY = "departments:all";

export interface DepartmentListResponse {
    items: DepartmentEntity[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}

function isDepartmentListResponse(value: unknown): value is DepartmentListResponse {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DepartmentListResponse>;
    return Array.isArray(candidate.items)
        && Boolean(candidate.pagination)
        && Number.isInteger(candidate.pagination?.page)
        && Number.isInteger(candidate.pagination?.limit)
        && Number.isInteger(candidate.pagination?.total)
        && Number.isInteger(candidate.pagination?.totalPages);
}

type RedisClient = NonNullable<typeof rateLimitRedisClient>;

export function createDepartmentCache(
    client: RedisClient | undefined = rateLimitRedisClient,
    connect: typeof connectRateLimitRedis = connectRateLimitRedis,
) {
    async function readyClient(): Promise<RedisClient | undefined> {
        if (!client) return undefined;
        await connect();
        return client;
    }

    async function invalidate(): Promise<void> {
        try {
            const redis = await readyClient();
            if (redis) await redis.del(DEPARTMENT_LIST_CACHE_KEY);
        } catch (error) {
            console.warn("Department cache invalidation failed; database mutation remains successful", error);
        }
    }

    return {
        async getDefault(): Promise<DepartmentListResponse | undefined> {
            let redis: RedisClient | undefined;
            try {
                redis = await readyClient();
                if (!redis) return undefined;

                const cached = await redis.get(DEPARTMENT_LIST_CACHE_KEY);
                if (cached === null) return undefined;

                let parsed: unknown;
                try {
                    parsed = JSON.parse(cached);
                } catch (error) {
                    console.warn("Malformed department cache JSON; using PostgreSQL", error);
                    await removeMalformedEntry(redis);
                    return undefined;
                }

                if (!isDepartmentListResponse(parsed)) {
                    console.warn("Invalid department cache shape; using PostgreSQL");
                    await removeMalformedEntry(redis);
                    return undefined;
                }

                return parsed as DepartmentListResponse;
            } catch (error) {
                console.warn("Department cache read failed; using PostgreSQL", error);
                return undefined;
            }
        },

        async setDefault(value: DepartmentListResponse): Promise<void> {
            try {
                const redis = await readyClient();
                if (redis) {
                    // No expiry is supplied: this cache is cleared after department mutations.
                    await redis.set(DEPARTMENT_LIST_CACHE_KEY, JSON.stringify(value));
                }
            } catch (error) {
                console.warn("Department cache write failed; PostgreSQL remains authoritative", error);
            }
        },

        invalidate,
    };
}

async function removeMalformedEntry(redis: RedisClient): Promise<void> {
    try {
        await redis.del(DEPARTMENT_LIST_CACHE_KEY);
    } catch (error) {
        console.warn("Malformed department cache entry could not be removed", error);
    }
}

export const departmentCache = createDepartmentCache();
