import {
    connectRateLimitRedis,
    rateLimitRedisClient,
} from "../config/rate-limit-store.js";
import type { DepartmentEntity } from "../entities/department.entity.js";
import { incrementRuntimeMetric } from "./runtime-metrics.js";

export const DEPARTMENT_LIST_CACHE_KEY = "departments:all";
const DEPARTMENT_DETAIL_PREFIX = "department:";
const DEPARTMENT_DETAIL_TTL_SECONDS = 300;

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

function isDepartment(value: unknown, expectedId: string): value is DepartmentEntity {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DepartmentEntity>;
    return candidate.id === expectedId
        && typeof candidate.name === "string"
        && (candidate.description === null || typeof candidate.description === "string");
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

    async function invalidateDepartment(id: string): Promise<void> {
        try {
            const redis = await readyClient();
            if (redis) await redis.del(`${DEPARTMENT_DETAIL_PREFIX}${id}`);
        } catch (error) {
            console.warn("Department detail cache invalidation failed; database mutation remains successful", error);
        }
    }

    return {
        async getDefault(): Promise<DepartmentListResponse | undefined> {
            let redis: RedisClient | undefined;
            try {
                redis = await readyClient();
                if (!redis) return undefined;

                const cached = await redis.get(DEPARTMENT_LIST_CACHE_KEY);
                if (cached === null) {
                    incrementRuntimeMetric("department_cache_miss");
                    return undefined;
                }

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

                incrementRuntimeMetric("department_cache_hit");
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
                    // No expiry: department mutations invalidate this entry after commit.
                    await redis.set(DEPARTMENT_LIST_CACHE_KEY, JSON.stringify(value));
                }
            } catch (error) {
                console.warn("Department cache write failed; PostgreSQL remains authoritative", error);
            }
        },

        async getDepartment(id: string): Promise<DepartmentEntity | undefined> {
            let redis: RedisClient | undefined;
            try {
                redis = await readyClient();
                if (!redis) return undefined;

                const key = `${DEPARTMENT_DETAIL_PREFIX}${id}`;
                const cached = await redis.get(key);
                if (cached === null) {
                    incrementRuntimeMetric("department_detail_cache_miss");
                    return undefined;
                }

                let parsed: unknown;
                try {
                    parsed = JSON.parse(cached);
                } catch (error) {
                    console.warn("Malformed department detail cache JSON; using PostgreSQL", error);
                    await removeDepartmentEntry(redis, key);
                    return undefined;
                }

                if (!isDepartment(parsed, id)) {
                    console.warn("Invalid department detail cache entry; using PostgreSQL");
                    await removeDepartmentEntry(redis, key);
                    return undefined;
                }

                incrementRuntimeMetric("department_detail_cache_hit");
                return parsed;
            } catch (error) {
                console.warn("Department detail cache read failed; using PostgreSQL", error);
                return undefined;
            }
        },

        async setDepartment(value: DepartmentEntity): Promise<void> {
            try {
                const redis = await readyClient();
                if (redis) {
                    await redis.set(
                        `${DEPARTMENT_DETAIL_PREFIX}${value.id}`,
                        JSON.stringify(value),
                        { EX: DEPARTMENT_DETAIL_TTL_SECONDS },
                    );
                }
            } catch (error) {
                console.warn("Department detail cache write failed; PostgreSQL remains authoritative", error);
            }
        },

        invalidate,
        invalidateDepartment,
    };
}

async function removeMalformedEntry(redis: RedisClient): Promise<void> {
    try {
        await redis.del(DEPARTMENT_LIST_CACHE_KEY);
    } catch (error) {
        console.warn("Malformed department cache entry could not be removed", error);
    }
}

async function removeDepartmentEntry(redis: RedisClient, key: string): Promise<void> {
    try {
        await redis.del(key);
    } catch (error) {
        console.warn("Malformed department detail cache entry could not be removed", error);
    }
}

export const departmentCache = createDepartmentCache();
