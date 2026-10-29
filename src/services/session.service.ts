
import {
    rateLimitRedisClient,
    connectRateLimitRedis,
} from "../config/rate-limit-store.js";

import type {
    AuthenticatedAccount,
} from "../repositories/authorization.repository.js";

const CACHE_TTL_SECONDS = 60;

interface CachedSession {
    sessionId: string;
    userId: string;
    role: AuthenticatedAccount["role"];
    createdAt: string;
}

export class SessionService {
    private key(sessionFamilyId: string): string {
        return `session:${sessionFamilyId}`;
    }

    // Redis key and stored sessionId both use the refresh-token family ID.
    async create(
        sessionFamilyId: string,
        userId: string,
        ttlSeconds: number,
    ): Promise<void> {
        if (!rateLimitRedisClient) {
            throw new Error("Redis is not configured");
        }

        await connectRateLimitRedis();

        const value = {
            sessionId: sessionFamilyId,
            userId,
            createdAt: new Date().toISOString(),
        };

        await rateLimitRedisClient.set(
            this.key(sessionFamilyId),
            JSON.stringify(value),
            { EX: ttlSeconds },
        );

        console.log("Redis session CREATED:", sessionFamilyId);
    }

    // PostgreSQL validates the active family; Redis remains a best-effort cache.
    async getAccount(
        sessionFamilyId: string,
        userId: string,
        fetchFromDb: () => Promise<AuthenticatedAccount | null>,
    ): Promise<AuthenticatedAccount | null> {
        // PostgreSQL is authoritative for revocation. A Redis hit must never
        // keep a revoked family usable after logout/reuse/password change.
        const account = await fetchFromDb();
        if (!account || !rateLimitRedisClient) return account;

        // Redis is an acceleration/inspection cache only. Cache outages,
        // expired keys, and malformed values must not change auth behavior.
        try {
            await connectRateLimitRedis();
            const key = this.key(sessionFamilyId);
            const value = await rateLimitRedisClient.get(key);
            const cached = value ? JSON.parse(value) as Partial<CachedSession> : null;
            if (
                !cached || cached.sessionId !== sessionFamilyId || cached.userId !== userId ||
                cached.role !== account.role
            ) {
                const cachedSession: CachedSession = {
                    sessionId: sessionFamilyId,
                    userId: account.id,
                    role: account.role,
                    createdAt: new Date().toISOString(),
                };
                await rateLimitRedisClient.set(key, JSON.stringify(cachedSession), { EX: CACHE_TTL_SECONDS });
            }
        } catch (error) {
            console.warn("Redis session cache unavailable; PostgreSQL authorization succeeded", error);
        }

        return account;
    }

    async exists(
        sessionFamilyId: string,
        userId: string,
    ): Promise<boolean> {
        if (!rateLimitRedisClient) {
            throw new Error("Redis is not configured");
        }

        await connectRateLimitRedis();

        const value = await rateLimitRedisClient.get(
            this.key(sessionFamilyId),
        );

        if (!value) {
            return false;
        }

        const session = JSON.parse(value) as {
            sessionId?: string;
            userId?: string;
        };

        return (
            session.sessionId === sessionFamilyId &&
            session.userId === userId
        );
    }

    async remove(sessionFamilyId: string): Promise<void> {
        if (!rateLimitRedisClient) {
            throw new Error("Redis is not configured");
        }

        await connectRateLimitRedis();

        await rateLimitRedisClient.del(this.key(sessionFamilyId));

        console.log("Redis session REMOVED:", sessionFamilyId);
    }

    async removeSafely(sessionIds: string[]): Promise<void> {
        if (!rateLimitRedisClient || sessionIds.length === 0) return;
        try {
            await connectRateLimitRedis();
            await rateLimitRedisClient.del(sessionIds.map((sessionId) => this.key(sessionId)));
        } catch (error) {
            // Database revocation remains authoritative when Redis is down.
            console.warn("Could not remove revoked Redis session cache entries", error);
        }
    }
}

export const sessionService = new SessionService();
