import { createClient } from "redis";
import { RedisStore } from "rate-limit-redis";
import { config } from "./config.js";

export const rateLimitRedisClient = config.REDIS_URL
    ? createClient({
        url: config.REDIS_URL,
        socket: {
            connectTimeout: config.REDIS_CONNECT_TIMEOUT_MS,
            reconnectStrategy: (retries) => {
                if (retries > config.REDIS_RETRY_ATTEMPTS) return new Error("Redis reconnect attempts exhausted");
                const delay = config.REDIS_RETRY_BASE_DELAY_MS * (2 ** (retries - 1));
                return delay + Math.floor(Math.random() * delay);
            },
        },
    })
    : undefined;

rateLimitRedisClient?.on("error", (error) => {
    console.error("Rate limit Redis connection error", error);
});

let redisConnection: Promise<void> | undefined;

export async function connectRateLimitRedis(): Promise<void> {
    if (!rateLimitRedisClient || rateLimitRedisClient.isOpen) return;

    // Share the in-flight connection attempt between the server and rate-limit stores.
    redisConnection ??= rateLimitRedisClient.connect().then(() => undefined).catch((error: unknown) => {
        redisConnection = undefined;
        throw error;
    });
    await redisConnection;
}

export async function closeRateLimitRedis(): Promise<void> {
    if (rateLimitRedisClient?.isOpen) await rateLimitRedisClient.quit();
}

export function createRateLimitStore(prefix: string): RedisStore | undefined {
    if (!rateLimitRedisClient) return undefined;
    return new RedisStore({
        prefix,
        sendCommand: async (...args: string[]) => {
            await connectRateLimitRedis();
            return rateLimitRedisClient.sendCommand(args as [string, ...string[]]);
        },
    });
}
