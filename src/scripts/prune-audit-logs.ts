import "reflect-metadata";
import { AppDataSource } from "../config/database.js";
import { config } from "../config/config.js";

async function pruneExpiredAuditLogs(): Promise<void> {
    try {
        await AppDataSource.initialize();
        const result: Array<{ deleted_count: string }> = await AppDataSource.query(
            `WITH removed AS (
                DELETE FROM audit_logs
                WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
                RETURNING id
            ) SELECT COUNT(*)::text AS deleted_count FROM removed`,
            [config.AUDIT_LOG_RETENTION_DAYS],
        );
        console.log(`Deleted ${result[0]?.deleted_count ?? "0"} audit records older than the configured ${config.AUDIT_LOG_RETENTION_DAYS}-day period.`);
    } catch {
        console.error("Could not prune audit logs. Check the database connection and migrations.");
        process.exitCode = 1;
    } finally {
        if (AppDataSource.isInitialized) await AppDataSource.destroy();
    }
}

void pruneExpiredAuditLogs();
