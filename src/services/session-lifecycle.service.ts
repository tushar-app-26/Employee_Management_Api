import { randomUUID } from "node:crypto";
import cron from "node-cron";
import type { EntityManager } from "typeorm";
import { AppDataSource } from "../config/database.js";
import { rateLimitRedisClient } from "../config/rate-limit-store.js";
import { config } from "../config/config.js";
import { getRuntimeMetrics, incrementRuntimeMetric } from "./runtime-metrics.js";

export type SessionLifecycleEventType =
    | "SESSION_CREATED"
    | "SESSION_EXPIRED"
    | "SESSION_REVOKED"
    | "LOGOUT"
    | "REFRESH_TOKEN_REUSE_DETECTED";

export interface SessionLifecycleEvent {
    eventKey: string;
    userId: string | null;
    sessionId: string;
    eventType: SessionLifecycleEventType;
    occurredAt?: Date;
    correlationId?: string | null;
    processingStatus?: "processed" | "reconciled";
    details?: Record<string, unknown>;
}

const expiryStreamKey = "session-events:expiry-pending";
const processingLockKey = "session-events:processing-lock";
const lockReleaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function redisDatabaseNumber(): number {
    try {
        return Number(new URL(config.REDIS_URL || "redis://localhost").pathname.slice(1)) || 0;
    } catch {
        return 0;
    }
}

function eventLog(
    eventType: string,
    sessionId: string,
    outcome: string,
    occurredAt: string,
): void {
    console.info("Session lifecycle event", {
        eventType,
        sessionId,
        eventTimestamp: occurredAt,
        outcome,
    });
}

function safeRecordId(recordType: "session" | "token", recordId: string): string {
    return recordType === "session" ? recordId : `sha256:${recordId.slice(0, 12)}`;
}

export class SessionLifecycleService {
    private subscriber: typeof rateLimitRedisClient = undefined;
    private subscriptionReady = false;
    private pollTimer: NodeJS.Timeout | undefined;
    private reconcileTask: ReturnType<typeof cron.schedule> | undefined;
    private summaryTask: ReturnType<typeof cron.schedule> | undefined;
    private draining = false;

    async record(event: SessionLifecycleEvent, manager?: EntityManager): Promise<void> {
        const db = manager ?? AppDataSource;
        const sql = `
            INSERT INTO session_lifecycle_events
                (event_key, user_id, session_id, event_type, occurred_at,
                 processing_status, correlation_id, details)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            ON CONFLICT (event_key) DO NOTHING
        `;
        const inserted = await db.query(sql + " RETURNING id", [
            event.eventKey,
            event.userId,
            event.sessionId,
            event.eventType,
            event.occurredAt ?? new Date(),
            event.processingStatus ?? "processed",
            event.correlationId ?? null,
            JSON.stringify(event.details ?? {}),
        ]) as Array<{ id: string }>;
        if (inserted.length) incrementRuntimeMetric(`session_audit_${event.eventType.toLowerCase()}`);
        eventLog(event.eventType, event.sessionId, inserted.length ? "recorded" : "duplicate_ignored", (event.occurredAt ?? new Date()).toISOString());
    }

    async start(): Promise<void> {
        if (!rateLimitRedisClient || this.subscriber) return;
        this.subscriber = rateLimitRedisClient.duplicate();
        this.subscriber.on("error", (error) => {
            this.subscriptionReady = false;
            console.error("Redis expiry subscriber error", error);
        });
        try {
            await this.subscriber.connect();
            const channel = `__keyevent@${redisDatabaseNumber()}__:expired`;
            await this.subscriber.subscribe(channel, (expiredKey) => {
                const isSession = expiredKey.startsWith("session:");
                const isTokenMetadata = expiredKey.startsWith("token-meta:refresh:");
                if (!isSession && !isTokenMetadata) return;
                const recordId = expiredKey.slice(isSession ? "session:".length : "token-meta:refresh:".length);
                if (!recordId) return;
                incrementRuntimeMetric("session_expiry_event_received");
                const occurredAt = new Date().toISOString();
                console.info("Session expiry notification received", {
                    eventType: isSession ? "SESSION_EXPIRED" : "REFRESH_TOKEN_METADATA_EXPIRED",
                    recordId: safeRecordId(isSession ? "session" : "token", recordId),
                    eventTimestamp: occurredAt,
                });
                void this.enqueueExpiry(isSession ? "session" : "token", recordId, occurredAt);
            });
            this.subscriptionReady = true;
            console.info("Redis expiry notifications subscribed", { channel });
        } catch (error) {
            this.subscriptionReady = false;
            console.error("Redis expiry notifications unavailable; reconciliation remains enabled", error);
        }

        this.pollTimer = setInterval(() => void this.drainExpiryEvents(), 5_000);
        this.pollTimer.unref();
        this.reconcileTask = cron.schedule("*/1 * * * *", () => void this.reconcile(), { timezone: "UTC" });
        this.summaryTask = cron.schedule("5 0 * * *", () => void this.generateDailySummary(), { timezone: "UTC" });
        void this.drainExpiryEvents();
    }

    async stop(): Promise<void> {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        this.reconcileTask?.stop();
        this.summaryTask?.stop();
        this.reconcileTask = undefined;
        this.summaryTask = undefined;
        if (this.subscriber?.isOpen) await this.subscriber.quit();
        this.subscriber = undefined;
        this.subscriptionReady = false;
    }

    getHealth(): { redisConnected: boolean; expiryNotificationsSubscribed: boolean; metrics: Record<string, number> } {
        return {
            redisConnected: Boolean(rateLimitRedisClient?.isReady),
            expiryNotificationsSubscribed: this.subscriptionReady,
            metrics: getRuntimeMetrics(),
        };
    }

    async getUserHistory(userId: string, page: number, limit: number) {
        const [items, count] = await Promise.all([
            AppDataSource.query(
                `SELECT event_type AS "eventType", session_id AS "sessionId",
                        occurred_at AS "occurredAt", processed_at AS "processedAt",
                        processing_status AS "processingStatus", correlation_id AS "correlationId"
                 FROM session_lifecycle_events
                 WHERE user_id = $1
                 ORDER BY occurred_at DESC
                 LIMIT $2 OFFSET $3`,
                [userId, limit, (page - 1) * limit],
            ) as Promise<Array<Record<string, unknown>>>,
            AppDataSource.query(
                "SELECT COUNT(*)::int AS total FROM session_lifecycle_events WHERE user_id = $1",
                [userId],
            ) as Promise<Array<{ total: number }>>,
        ]);
        const total = Number(count[0]?.total ?? 0);
        return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
    }

    async getAdminMetrics() {
        const [daily, totals] = await Promise.all([
            AppDataSource.query(
                `SELECT summary_date AS "summaryDate", expired_sessions AS "expiredSessions",
                        manually_revoked_sessions AS "manuallyRevokedSessions",
                        refresh_token_reuse_detections AS "refreshTokenReuseDetections",
                        generated_at AS "generatedAt"
                 FROM session_daily_summaries ORDER BY summary_date DESC LIMIT 30`,
            ) as Promise<Array<Record<string, unknown>>>,
            AppDataSource.query(
                `SELECT event_type AS "eventType", COUNT(*)::int AS count
                 FROM session_lifecycle_events
                 WHERE occurred_at >= NOW() - INTERVAL '30 days'
                 GROUP BY event_type ORDER BY event_type`,
            ) as Promise<Array<{ eventType: string; count: number }>>,
        ]);
        return { last30Days: totals, dailySummaries: daily, runtime: this.getHealth() };
    }

    async reconcile(): Promise<void> {
        try {
            const expired = await AppDataSource.query(`
                WITH expired_sessions AS (
                    SELECT user_id, family_id, MAX(expires_at) AS occurred_at
                    FROM refresh_tokens
                    GROUP BY user_id, family_id
                    HAVING MAX(expires_at) <= NOW()
                )
                INSERT INTO session_lifecycle_events
                    (event_key, user_id, session_id, event_type, occurred_at,
                     processed_at, processing_status, details)
                SELECT 'SESSION_EXPIRED:' || expired_sessions.family_id::text,
                       expired_sessions.user_id, expired_sessions.family_id,
                       'SESSION_EXPIRED', expired_sessions.occurred_at,
                       NOW(), 'reconciled', '{}'::jsonb
                FROM expired_sessions
                WHERE NOT EXISTS (
                    SELECT 1 FROM session_lifecycle_events prior
                    WHERE prior.session_id = expired_sessions.family_id
                      AND prior.event_type IN ('SESSION_REVOKED', 'LOGOUT')
                )
                ON CONFLICT (event_key) DO NOTHING
                RETURNING session_id
            `) as Array<{ session_id: string }>;

            for (const row of expired) {
                incrementRuntimeMetric("session_expiry_event_processed");
                eventLog("SESSION_EXPIRED", row.session_id, "reconciled", new Date().toISOString());
            }

            const inactive = await AppDataSource.query(`
                SELECT DISTINCT token.user_id, token.family_id
                FROM refresh_tokens token
                JOIN users account ON account.id = token.user_id
                WHERE account.is_active = FALSE
                  AND token.revoked_at IS NULL
                  AND token.expires_at > NOW()
            `) as Array<{ user_id: string; family_id: string }>;
            for (const session of inactive) {
                await AppDataSource.transaction(async (manager) => {
                    await manager.query(
                        `UPDATE refresh_tokens SET revoked_at = NOW()
                         WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
                        [session.user_id, session.family_id],
                    );
                    await this.record({
                        eventKey: `SESSION_REVOKED:${session.family_id}`,
                        userId: session.user_id,
                        sessionId: session.family_id,
                        eventType: "SESSION_REVOKED",
                        processingStatus: "reconciled",
                        details: { reason: "inactive_account_reconciliation" },
                    }, manager);
                });
            }
        } catch (error) {
            incrementRuntimeMetric("session_reconciliation_failure");
            console.error("Session reconciliation failed", {
                eventType: "SESSION_RECONCILIATION",
                outcome: "retry_scheduled",
                error,
            });
        }
    }

    async generateDailySummary(forDate?: Date): Promise<void> {
        try {
            if (forDate) {
                const date = forDate.toISOString().slice(0, 10);
                await this.upsertDailySummary(date);
                console.info("Session daily summary generated", { summaryDate: date });
                return;
            }

            // Rebuild the recent window so a previous DB outage does not leave a permanent gap.
            await AppDataSource.query(`
                INSERT INTO session_daily_summaries
                    (summary_date, expired_sessions, manually_revoked_sessions, refresh_token_reuse_detections)
                SELECT days.summary_date::date,
                    COUNT(events.id) FILTER (WHERE events.event_type = 'SESSION_EXPIRED')::int,
                    COUNT(events.id) FILTER (WHERE events.event_type = 'SESSION_REVOKED')::int,
                    COUNT(events.id) FILTER (WHERE events.event_type = 'REFRESH_TOKEN_REUSE_DETECTED')::int
                FROM generate_series(
                    (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 30)::timestamp),
                    (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 1)::timestamp),
                    INTERVAL '1 day'
                ) AS days(summary_date)
                LEFT JOIN session_lifecycle_events events
                    ON events.occurred_at AT TIME ZONE 'UTC' >= days.summary_date
                   AND events.occurred_at AT TIME ZONE 'UTC' < days.summary_date + INTERVAL '1 day'
                GROUP BY days.summary_date
                ON CONFLICT (summary_date) DO UPDATE SET
                    expired_sessions = EXCLUDED.expired_sessions,
                    manually_revoked_sessions = EXCLUDED.manually_revoked_sessions,
                    refresh_token_reuse_detections = EXCLUDED.refresh_token_reuse_detections,
                    generated_at = CURRENT_TIMESTAMP
            `);
            console.info("Recent session daily summaries generated", { days: 30 });
        } catch (error) {
            incrementRuntimeMetric("session_daily_summary_failure");
            console.error("Session daily summary generation failed; the next scheduled run will retry", { error });
        }
    }

    private async upsertDailySummary(date: string): Promise<void> {
        await AppDataSource.query(`
            INSERT INTO session_daily_summaries
                (summary_date, expired_sessions, manually_revoked_sessions, refresh_token_reuse_detections)
            SELECT $1::date,
                COUNT(*) FILTER (WHERE event_type = 'SESSION_EXPIRED')::int,
                COUNT(*) FILTER (WHERE event_type = 'SESSION_REVOKED')::int,
                COUNT(*) FILTER (WHERE event_type = 'REFRESH_TOKEN_REUSE_DETECTED')::int
            FROM session_lifecycle_events
            WHERE occurred_at >= $1::date AND occurred_at < ($1::date + INTERVAL '1 day')
            ON CONFLICT (summary_date) DO UPDATE SET
                expired_sessions = EXCLUDED.expired_sessions,
                manually_revoked_sessions = EXCLUDED.manually_revoked_sessions,
                refresh_token_reuse_detections = EXCLUDED.refresh_token_reuse_detections,
                generated_at = CURRENT_TIMESTAMP
        `, [date]);
    }

    async enqueueExpiredSessionEvent(sessionId: string, occurredAt = new Date()): Promise<void> {
        await this.enqueueExpiry("session", sessionId, occurredAt.toISOString());
    }

    async enqueueExpiredTokenMetadataEvent(tokenHash: string, occurredAt = new Date()): Promise<void> {
        await this.enqueueExpiry("token", tokenHash, occurredAt.toISOString());
    }

    private async enqueueExpiry(recordType: "session" | "token", recordId: string, occurredAt: string): Promise<void> {
        if (!rateLimitRedisClient) return;
        try {
            await rateLimitRedisClient.xAdd(expiryStreamKey, "*", {
                eventType: "SESSION_EXPIRED",
                recordType,
                // Token hashes are safe lookup identifiers; raw tokens are never queued.
                recordId,
                occurredAt,
            });
            await this.drainExpiryEvents();
        } catch (error) {
            incrementRuntimeMetric("session_expiry_event_retry");
            console.error("Could not queue session expiry event; reconciliation will recover it", {
                recordId: safeRecordId(recordType, recordId),
                error,
            });
        }
    }

    private async drainExpiryEvents(): Promise<void> {
        if (this.draining || !rateLimitRedisClient?.isReady || !AppDataSource.isInitialized) return;
        this.draining = true;
        const client = rateLimitRedisClient;
        const lockToken = randomUUID();
        try {
            const acquired = await client.set(processingLockKey, lockToken, { NX: true, EX: 30 });
            if (acquired !== "OK") return;
            const response = await client.sendCommand(["XRANGE", expiryStreamKey, "-", "+", "COUNT", "100"]) as unknown;
            if (!Array.isArray(response)) return;
            for (const item of response) {
                if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
                const streamId = item[0];
                const fields = item[1] as unknown[];
                const values = new Map<string, string>();
                for (let index = 0; index + 1 < fields.length; index += 2) {
                    if (typeof fields[index] === "string" && typeof fields[index + 1] === "string") {
                        values.set(fields[index] as string, fields[index + 1] as string);
                    }
                }
                const recordType = values.get("recordType");
                const recordId = values.get("recordId");
                const occurredAtText = values.get("occurredAt");
                if (!recordId || !occurredAtText || (recordType !== "session" && recordType !== "token")) {
                    await client.sendCommand(["XDEL", expiryStreamKey, streamId]);
                    continue;
                }
                try {
                    if (recordType === "session") {
                        await this.recordExpiredSession(recordId, new Date(occurredAtText));
                    } else {
                        await this.recordExpiredTokenMetadata(recordId, new Date(occurredAtText));
                    }
                    await client.sendCommand(["XDEL", expiryStreamKey, streamId]);
                    incrementRuntimeMetric("session_expiry_event_processed");
                } catch (error) {
                    incrementRuntimeMetric("session_expiry_event_retry");
                    console.error("Session expiry audit remains queued for retry", {
                        recordId: safeRecordId(recordType, recordId),
                        error,
                    });
                    break;
                }
            }
        } catch (error) {
            console.error("Session expiry queue processing failed", error);
        } finally {
            await client.eval(lockReleaseScript, { keys: [processingLockKey], arguments: [lockToken] }).catch(() => undefined);
            this.draining = false;
        }
    }

    private async recordExpiredTokenMetadata(tokenHash: string, notifiedAt: Date): Promise<void> {
        const rows = await AppDataSource.query(
            `SELECT user_id, family_id, MAX(expires_at) AS family_expires_at
             FROM refresh_tokens WHERE token_hash = $1 GROUP BY user_id, family_id`,
            [tokenHash],
        ) as Array<{ user_id: string; family_id: string; family_expires_at: Date }>;
        const token = rows[0];
        if (!token) {
            eventLog("REFRESH_TOKEN_METADATA_EXPIRED", "unknown", "metadata_only", notifiedAt.toISOString());
            return;
        }
        if (new Date(token.family_expires_at).getTime() > Date.now()) {
            eventLog("REFRESH_TOKEN_METADATA_EXPIRED", token.family_id, "rotated_token_metadata_only", notifiedAt.toISOString());
            return;
        }
        await this.record({
            eventKey: `SESSION_EXPIRED:${token.family_id}`,
            userId: token.user_id,
            sessionId: token.family_id,
            eventType: "SESSION_EXPIRED",
            occurredAt: new Date(token.family_expires_at),
            correlationId: `redis-token-expiry:${token.family_id}`,
        });
    }

    private async recordExpiredSession(sessionId: string, notifiedAt: Date): Promise<void> {
        const rows = await AppDataSource.query(
            `SELECT user_id, MAX(expires_at) AS expires_at
             FROM refresh_tokens WHERE family_id = $1 GROUP BY user_id`,
            [sessionId],
        ) as Array<{ user_id: string; expires_at: Date }>;
        const session = rows[0];
        if (!session) return;
        const explicitlyEnded = await AppDataSource.query(
            `SELECT 1 FROM session_lifecycle_events
             WHERE session_id = $1 AND event_type IN ('SESSION_REVOKED', 'LOGOUT') LIMIT 1`,
            [sessionId],
        ) as unknown[];
        if (explicitlyEnded.length) {
            eventLog("SESSION_EXPIRED", sessionId, "ignored_after_explicit_revocation", notifiedAt.toISOString());
            return;
        }
        const occurredAt = new Date(session.expires_at);
        await this.record({
            eventKey: `SESSION_EXPIRED:${sessionId}`,
            userId: session.user_id,
            sessionId,
            eventType: "SESSION_EXPIRED",
            occurredAt,
            correlationId: `redis-expiry:${sessionId}`,
        });
    }
}

export const sessionLifecycleService = new SessionLifecycleService();
