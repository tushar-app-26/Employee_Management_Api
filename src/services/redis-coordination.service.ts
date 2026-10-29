import { createHash, randomUUID } from "node:crypto";
import { config } from "../config/config.js";
import {
    connectRateLimitRedis,
    rateLimitRedisClient,
} from "../config/rate-limit-store.js";
import { AppError } from "../errors/app-error.js";

const incrementAndExpireScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

const incrementDocumentLinkCounterScript = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local windowSeconds = tonumber(ARGV[3])
local nowIso = ARGV[4]
local raw = redis.call('GET', KEYS[1])
local remainingTtl = redis.call('PTTL', KEYS[1])
local count = 0
local windowStartedAt = tostring(now)

if raw then
  local ok, record = pcall(cjson.decode, raw)
  if ok and type(record) == 'table' then
    count = tonumber(record.count) or 0
    windowStartedAt = tostring(tonumber(record.windowStartedAtUnixMs) or now)
  else
    -- Migrate existing numeric counters while keeping their current expiry window.
    count = tonumber(raw) or 0
    if remainingTtl > 0 then
      windowStartedAt = tostring(now - (windowSeconds * 1000 - remainingTtl))
    end
  end
end

count = count + 1
if remainingTtl <= 0 then remainingTtl = windowSeconds * 1000 end
local record = {
  count = count,
  limit = limit,
  remainingRequests = math.max(0, limit - count),
  blocked = count > limit,
  windowSeconds = windowSeconds,
  windowStartedAtUnixMs = tonumber(windowStartedAt) or now,
  lastRequestAt = nowIso,
  resetAtUnixMs = now + remainingTtl
}
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', remainingTtl)
return count
`;

const incrementLoginFailureCounterScript = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])
local nowIso = ARGV[4]
local raw = redis.call('GET', KEYS[1])
local remainingTtl = redis.call('PTTL', KEYS[1])
local count = 0

if raw then
  local ok, record = pcall(cjson.decode, raw)
  if ok and type(record) == 'table' then
    count = tonumber(record.count) or 0
  else
    count = tonumber(raw) or 0
  end
end

count = count + 1
if remainingTtl <= 0 then remainingTtl = ttlSeconds * 1000 end
local record = {
  count = count,
  limit = limit,
  remainingAttempts = math.max(0, limit - count),
  resetAtUnixMs = now + remainingTtl,
  updatedAt = nowIso
}
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', remainingTtl)
return count
`;

const completeIdempotencyScript = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.token ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

const releaseIdempotencyScript = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.token ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

interface IdempotencyRecord {
    status: "processing" | "completed";
    token: string;
    fingerprint: string;
    result?: unknown;
}

export interface IdempotentResult<T> {
    value: T;
    replayed: boolean;
}

async function getRedisClient() {
    if (!rateLimitRedisClient) return undefined;
    try {
        await connectRateLimitRedis();
        return rateLimitRedisClient;
    } catch (error) {
        throw new AppError(503, "Redis is temporarily unavailable", "REDIS_UNAVAILABLE", { cause: error });
    }
}

function assertIdempotencyKey(key: string): string {
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 200 || /[^\x21-\x7E]/.test(trimmed)) {
        throw new AppError(400, "Idempotency-Key must contain 1 to 200 visible ASCII characters", "INVALID_IDEMPOTENCY_KEY");
    }
    return trimmed;
}

export function fingerprintJson(value: unknown): string {
    const canonicalize = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(canonicalize);
        if (input && typeof input === "object") {
            return Object.fromEntries(
                Object.entries(input)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, entry]) => [key, canonicalize(entry)]),
            );
        }
        return input;
    };

    return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export class RedisCoordinationService {
    async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number | undefined> {
        const client = await getRedisClient();
        if (!client) return undefined;

        try {
            const result: unknown = await client.eval(incrementAndExpireScript, {
                keys: [key],
                arguments: [String(ttlSeconds)],
            });
            return Number(result);
        } catch (error) {
            throw new AppError(503, "Redis is temporarily unavailable", "REDIS_UNAVAILABLE", { cause: error });
        }
    }

    async incrementDocumentLinkCounter(
        key: string,
        ttlSeconds: number,
        limit: number,
    ): Promise<number | undefined> {
        const client = await getRedisClient();
        if (!client) return undefined;

        try {
            const result: unknown = await client.eval(incrementDocumentLinkCounterScript, {
                keys: [key],
                arguments: [String(Date.now()), String(limit), String(ttlSeconds), new Date().toISOString()],
            });
            return Number(result);
        } catch (error) {
            throw new AppError(503, "Redis is temporarily unavailable", "REDIS_UNAVAILABLE", { cause: error });
        }
    }

    async incrementLoginFailureCounter(
        key: string,
        ttlSeconds: number,
        limit: number,
    ): Promise<number | undefined> {
        const client = await getRedisClient();
        if (!client) return undefined;

        try {
            const result: unknown = await client.eval(incrementLoginFailureCounterScript, {
                keys: [key],
                arguments: [String(Date.now()), String(limit), String(ttlSeconds), new Date().toISOString()],
            });
            return Number(result);
        } catch (error) {
            throw new AppError(503, "Redis is temporarily unavailable", "REDIS_UNAVAILABLE", { cause: error });
        }
    }

    async getCounter(key: string): Promise<number | undefined> {
        const client = await getRedisClient();
        if (!client) return undefined;

        try {
            const value = await client.get(key);
            if (value === null) return 0;
            try {
                const record: unknown = JSON.parse(value);
                if (record && typeof record === "object" && "count" in record) {
                    return Number((record as { count: unknown }).count);
                }
            } catch {
                // Continue supporting numeric counters created before JSON storage.
            }
            return Number(value);
        } catch (error) {
            throw new AppError(503, "Redis is temporarily unavailable", "REDIS_UNAVAILABLE", { cause: error });
        }
    }

    async deleteKey(key: string): Promise<void> {
        const client = await getRedisClient();
        if (!client) return;

        try {
            await client.del(key);
        } catch (error) {
            throw new AppError(503, "Redis is temporarily unavailable", "REDIS_UNAVAILABLE", { cause: error });
        }
    }

    async runIdempotent<T>(options: {
        scope: string;
        actorId: string;
        requestKey?: string;
        fingerprint: string;
        operation: () => Promise<T>;
    }): Promise<IdempotentResult<T>> {
        if (options.requestKey === undefined) {
            return { value: await options.operation(), replayed: false };
        }

        const requestKey = assertIdempotencyKey(options.requestKey);
        const client = await getRedisClient();

        // Non-production installations may run without Redis; production config requires it.
        if (!client) return { value: await options.operation(), replayed: false };

        const identity = createHash("sha256")
            .update(`${options.actorId}:${options.scope}:${requestKey}`)
            .digest("hex");
        const redisKey = `idempotency:${identity}`;
        const token = randomUUID();
        const ttlSeconds = config.IDEMPOTENCY_TTL_SECONDS;
        const pending: IdempotencyRecord = {
            status: "processing",
            token,
            fingerprint: options.fingerprint,
        };

        try {
            const claimed = await client.set(redisKey, JSON.stringify(pending), {
                NX: true,
                EX: ttlSeconds,
            });

            if (claimed !== "OK") {
                const existingText = await client.get(redisKey);
                if (!existingText) {
                    throw new AppError(409, "The request is being retried; send it again", "IDEMPOTENCY_RETRY");
                }

                let existing: IdempotencyRecord;
                try {
                    existing = JSON.parse(existingText) as IdempotencyRecord;
                } catch (error) {
                    throw new AppError(503, "Stored idempotency state is invalid", "IDEMPOTENCY_STATE_INVALID", { cause: error });
                }

                if (existing.fingerprint !== options.fingerprint) {
                    throw new AppError(409, "This Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
                }
                if (existing.status === "processing") {
                    throw new AppError(409, "A request with this Idempotency-Key is still processing", "IDEMPOTENCY_IN_PROGRESS");
                }

                return { value: existing.result as T, replayed: true };
            }
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError(503, "Redis is temporarily unavailable", "REDIS_UNAVAILABLE", { cause: error });
        }

        let result: T;
        try {
            result = await options.operation();
        } catch (error) {
            await this.releaseIdempotencyClaim(client, redisKey, token);
            throw error;
        }

        const completed: IdempotencyRecord = {
            status: "completed",
            token,
            fingerprint: options.fingerprint,
            result,
        };

        try {
            const stored: unknown = await client.eval(completeIdempotencyScript, {
                keys: [redisKey],
                arguments: [token, JSON.stringify(completed), String(ttlSeconds)],
            });
            if (Number(stored) !== 1) {
                throw new AppError(503, "Idempotency claim expired before the operation completed", "IDEMPOTENCY_CLAIM_EXPIRED");
            }
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError(503, "Redis could not save the idempotency result", "REDIS_UNAVAILABLE", { cause: error });
        }

        return { value: result, replayed: false };
    }

    private async releaseIdempotencyClaim(
        client: NonNullable<typeof rateLimitRedisClient>,
        key: string,
        token: string,
    ): Promise<void> {
        try {
            await client.eval(releaseIdempotencyScript, {
                keys: [key],
                arguments: [token],
            });
        } catch (error) {
            console.error("Could not release failed idempotency claim", { key, error });
        }
    }
}

export const redisCoordinationService = new RedisCoordinationService();
