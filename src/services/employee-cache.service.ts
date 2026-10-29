
import { createHash } from "node:crypto";
import {
    connectRateLimitRedis,
    rateLimitRedisClient,
} from "../config/rate-limit-store.js";
import { incrementRuntimeMetric } from "./runtime-metrics.js";

const EMPLOYEE_DETAIL_PREFIX = "employees:detail:";
const EMPLOYEE_LIST_PREFIX = "employees:list:";

const EMPLOYEE_DETAIL_TTL_SECONDS = 300;
const EMPLOYEE_LIST_TTL_SECONDS = 60;

export interface EmployeeCacheTtls {
    detailSeconds: number;
    listSeconds: number;
}

type RedisClient = NonNullable<typeof rateLimitRedisClient>;

function createListKey(filters: unknown): string {
    const normalized = JSON.stringify(filters ?? {});
    const hash = createHash("sha256")
        .update(normalized)
        .digest("hex");

    return `${EMPLOYEE_LIST_PREFIX}${hash}`;
}

export function createEmployeeCache(
    client: RedisClient | undefined = rateLimitRedisClient,
    connect: typeof connectRateLimitRedis = connectRateLimitRedis,
    ttls: EmployeeCacheTtls = {
        detailSeconds: EMPLOYEE_DETAIL_TTL_SECONDS,
        listSeconds: EMPLOYEE_LIST_TTL_SECONDS,
    },
) {
    async function readyClient(): Promise<RedisClient | undefined> {
        if (!client) return undefined;

        await connect();
        return client;
    }

    async function deleteKeys(keys: string[]): Promise<void> {
        if (keys.length === 0) return;

        try {
            const redis = await readyClient();

            if (redis) {
                await redis.del(keys);
            }
        } catch (error) {
            console.warn(
                "Employee cache invalidation failed; database remains authoritative",
                error,
            );
        }
    }

    async function invalidateEmployeeKeys(): Promise<void> {
        try {
            const redis = await readyClient();
            if (!redis) return;

            // SCAN avoids blocking Redis as KEYS can.
            let cursor = "0";

            do {
                const result = await redis.scan(cursor, {
                    MATCH: "employees:*",
                    COUNT: 100,
                });

                cursor = result.cursor;

                if (result.keys.length > 0) {
                    await redis.del(result.keys);
                }
            } while (cursor !== "0");
        } catch (error) {
            console.warn(
                "Employee cache invalidation failed; database remains authoritative",
                error,
            );
        }
    }

    return {
        async getDetail<T>(id: string): Promise<T | undefined> {
            try {
                const redis = await readyClient();
                if (!redis) return undefined;

                const key = `${EMPLOYEE_DETAIL_PREFIX}${id}`;
                const cached = await redis.get(key);

                if (cached === null) {
                    incrementRuntimeMetric("employee_detail_cache_miss");
                    return undefined;
                }

                try {
                    incrementRuntimeMetric("employee_detail_cache_hit");
                    return JSON.parse(cached) as T;
                } catch (error) {
                    console.warn(
                        "Malformed employee detail cache; using PostgreSQL",
                        error,
                    );

                    await deleteKeys([key]);
                    return undefined;
                }
            } catch (error) {
                console.warn(
                    "Employee detail cache read failed; using PostgreSQL",
                    error,
                );

                return undefined;
            }
        },

        async setDetail(id: string, value: unknown): Promise<void> {
            try {
                const redis = await readyClient();
                if (!redis) return;

                await redis.set(
                    `${EMPLOYEE_DETAIL_PREFIX}${id}`,
                    JSON.stringify(value),
                    { EX: ttls.detailSeconds },
                );
            } catch (error) {
                console.warn(
                    "Employee detail cache write failed; PostgreSQL remains authoritative",
                    error,
                );
            }
        },

        async getList<T>(filters: unknown): Promise<T | undefined> {
            const key = createListKey(filters);

            try {
                const redis = await readyClient();
                if (!redis) return undefined;

                const cached = await redis.get(key);

                if (cached === null) {
                    incrementRuntimeMetric("employee_list_cache_miss");
                    return undefined;
                }

                try {
                    incrementRuntimeMetric("employee_list_cache_hit");
                    return JSON.parse(cached) as T;
                } catch (error) {
                    console.warn(
                        "Malformed employee list cache; using PostgreSQL",
                        error,
                    );

                    await deleteKeys([key]);
                    return undefined;
                }
            } catch (error) {
                console.warn(
                    "Employee list cache read failed; using PostgreSQL",
                    error,
                );

                return undefined;
            }
        },

        async setList(
            filters: unknown,
            value: unknown,
        ): Promise<void> {
            try {
                const redis = await readyClient();
                if (!redis) return;

                await redis.set(
                    createListKey(filters),
                    JSON.stringify(value),
                    { EX: ttls.listSeconds },
                );
            } catch (error) {
                console.warn(
                    "Employee list cache write failed; PostgreSQL remains authoritative",
                    error,
                );
            }
        },

        async invalidateDetail(id: string): Promise<void> {
            await deleteKeys([
                `${EMPLOYEE_DETAIL_PREFIX}${id}`,
            ]);
        },

        async invalidateAll(): Promise<void> {
            await invalidateEmployeeKeys();
        },
    };
}

export const employeeCache = createEmployeeCache();
