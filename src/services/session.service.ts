import {
    rateLimitRedisClient,
    connectRateLimitRedis,
} from "../config/rate-limit-store.js";
import { AppError } from "../errors/app-error.js";
import type { AuthenticatedAccount } from "../repositories/authorization.repository.js";

interface RedisSession {
    sessionId: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
}

type RedisClient = NonNullable<typeof rateLimitRedisClient>;

function parseSession(value: string): RedisSession | null {
    try {
        const candidate: unknown = JSON.parse(value);
        if (!candidate || typeof candidate !== "object") return null;
        const session = candidate as Partial<RedisSession>;
        if (
            typeof session.sessionId !== "string" ||
            typeof session.userId !== "string" ||
            typeof session.createdAt !== "string" ||
            typeof session.expiresAt !== "string" ||
            !(session.revokedAt === null || typeof session.revokedAt === "string")
        ) return null;
        return session as RedisSession;
    } catch {
        return null;
    }
}

async function getReadyClient(): Promise<RedisClient> {
    if (!rateLimitRedisClient) {
        throw new AppError(503, "Session service is temporarily unavailable", "SESSION_STORE_UNAVAILABLE");
    }
    try {
        await connectRateLimitRedis();
        return rateLimitRedisClient;
    } catch (error) {
        throw new AppError(503, "Session service is temporarily unavailable", "SESSION_STORE_UNAVAILABLE", { cause: error });
    }
}

function unavailable(error: unknown): AppError {
    if (error instanceof AppError) return error;
    return new AppError(503, "Session service is temporarily unavailable", "SESSION_STORE_UNAVAILABLE", { cause: error });
}

const revokeSessionScript = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local ok, session = pcall(cjson.decode, value)
if not ok or type(session) ~= 'table' then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
session.revokedAt = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(session), 'PX', ttl)
return 1
`;

export class SessionService {
    private key(sessionId: string): string {
        return `session:${sessionId}`;
    }

    private tokenKey(tokenHash: string): string {
        return `token-meta:refresh:${tokenHash}`;
    }

    async storeRefreshTokenMetadata(input: {
        tokenHash: string;
        userId: string;
        sessionId: string;
        expiresAt: Date;
        revokedAt?: Date | null;
    }): Promise<void> {
        const ttlSeconds = Math.ceil((input.expiresAt.getTime() - Date.now()) / 1000);
        if (ttlSeconds <= 0) return;
        const client = await getReadyClient();
        try {
            await client.set(this.tokenKey(input.tokenHash), JSON.stringify({
                tokenHash: input.tokenHash,
                userId: input.userId,
                sessionId: input.sessionId,
                expiresAt: input.expiresAt.toISOString(),
                revokedAt: input.revokedAt?.toISOString() ?? null,
            }), { EX: ttlSeconds });
        } catch (error) {
            throw unavailable(error);
        }
    }

    async markRefreshTokenRevoked(tokenHash: string, revokedAt: Date): Promise<void> {
        const client = await getReadyClient();
        const key = this.tokenKey(tokenHash);
        try {
            const value = await client.get(key);
            if (!value) return;
            const metadata = JSON.parse(value) as Record<string, unknown>;
            const ttl = await client.ttl(key);
            if (ttl > 0) {
                metadata.revokedAt = revokedAt.toISOString();
                await client.set(key, JSON.stringify(metadata), { EX: ttl });
            }
        } catch (error) {
            throw unavailable(error);
        }
    }

    async create(sessionId: string, userId: string, ttlSeconds: number, expiresAtOverride?: Date): Promise<void> {
        const client = await getReadyClient();
        const now = Date.now();
        const expiresAt = expiresAtOverride ?? new Date(now + ttlSeconds * 1000);
        const remainingSeconds = Math.ceil((expiresAt.getTime() - now) / 1000);
        if (remainingSeconds <= 0) throw new AppError(401, "Session has expired", "SESSION_UNAVAILABLE");
        const session: RedisSession = {
            sessionId,
            userId,
            createdAt: new Date(now).toISOString(),
            expiresAt: expiresAt.toISOString(),
            revokedAt: null,
        };
        try {
            await client.set(this.key(sessionId), JSON.stringify(session), { EX: remainingSeconds });
        } catch (error) {
            throw unavailable(error);
        }
        console.log("Redis session created", { sessionId, userId, expiresAt: session.expiresAt });
    }

    async getAccount(
        sessionId: string,
        userId: string,
        fetchFromDb: () => Promise<AuthenticatedAccount | null>,
    ): Promise<AuthenticatedAccount | null> {
        const client = await getReadyClient();
        let value: string | null;
        try {
            value = await client.get(this.key(sessionId));
        } catch (error) {
            console.warn("Session lookup", { sessionId, source: "Redis", result: "unavailable" });
            throw unavailable(error);
        }

        if (!value) {
            console.info("Session lookup", { sessionId, source: "Redis", result: "not_found" });
            return null;
        }
        const session = parseSession(value);
        if (
            !session ||
            session.sessionId !== sessionId ||
            session.userId !== userId ||
            session.revokedAt !== null ||
            Date.parse(session.expiresAt) <= Date.now()
        ) {
            console.info("Session lookup", { sessionId, source: "Redis", result: "rejected" });
            return null;
        }

        // PostgreSQL still confirms that the account is active and its refresh-token family is valid.
        console.info("Session lookup", { sessionId, source: "Redis", result: "found" });
        const account = await fetchFromDb();
        console.info("Session authorization", {
            sessionId,
            source: "PostgreSQL",
            result: account ? "active" : "inactive_or_revoked",
        });
        return account;
    }

    async exists(sessionId: string, userId: string): Promise<boolean> {
        const client = await getReadyClient();
        let value: string | null;
        try {
            value = await client.get(this.key(sessionId));
        } catch (error) {
            throw unavailable(error);
        }
        if (!value) return false;
        const session = parseSession(value);
        return Boolean(
            session && session.sessionId === sessionId && session.userId === userId &&
            session.revokedAt === null && Date.parse(session.expiresAt) > Date.now(),
        );
    }

    async extend(sessionId: string, expiresAt: Date): Promise<void> {
        const client = await getReadyClient();
        const key = this.key(sessionId);
        let value: string | null;
        try {
            value = await client.get(key);
        } catch (error) {
            throw unavailable(error);
        }
        const session = value ? parseSession(value) : null;
        const ttlSeconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
        if (!session || session.revokedAt !== null || ttlSeconds <= 0) {
            throw new AppError(401, "Session has expired or been revoked", "SESSION_UNAVAILABLE");
        }
        session.expiresAt = expiresAt.toISOString();
        try {
            await client.set(key, JSON.stringify(session), { EX: ttlSeconds });
        } catch (error) {
            throw unavailable(error);
        }
    }

    async remove(sessionId: string): Promise<void> {
        const client = await getReadyClient();
        try {
            await client.eval(revokeSessionScript, {
                keys: [this.key(sessionId)],
                arguments: [new Date().toISOString()],
            });
        } catch (error) {
            throw unavailable(error);
        }
        console.log("Redis session revoked", { sessionId });
    }

    async removeSafely(sessionIds: string[]): Promise<void> {
        if (!sessionIds.length) return;
        try {
            const client = await getReadyClient();
            const revokedAt = new Date().toISOString();
            for (const sessionId of sessionIds) {
                await client.eval(revokeSessionScript, {
                    keys: [this.key(sessionId)],
                    arguments: [revokedAt],
                });
            }
        } catch (error) {
            // PostgreSQL revocation remains authoritative if Redis cleanup fails.
            console.warn("Could not mark revoked Redis sessions", error);
        }
    }
}

export const sessionService = new SessionService();
