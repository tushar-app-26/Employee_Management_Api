import { AppDataSource } from "../config/database.js";
import { config } from "../config/config.js";
import { logger } from "../utils/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;
let cleanupInProgress = false;

async function removeExpiredRefreshTokens(): Promise<void> {
    if (cleanupInProgress || !AppDataSource.isInitialized) return;
    cleanupInProgress = true;
    try {
        await AppDataSource.query(
            `UPDATE refresh_tokens SET replay_token_ciphertext = NULL, replay_grace_expires_at = NULL
             WHERE replay_grace_expires_at <= NOW() AND replay_token_ciphertext IS NOT NULL`,
        );
        const removed: Array<{ id: string }> = await AppDataSource.query(
            `DELETE FROM refresh_tokens
             WHERE expires_at < NOW() - ($1 * INTERVAL '1 day')
                OR revoked_at < NOW() - ($1 * INTERVAL '1 day')
             RETURNING id`,
            [config.REFRESH_TOKEN_RETENTION_DAYS],
        );
        if (removed.length > 0) {
            logger.info({ count: removed.length }, "Old refresh-token records removed");
        }
    } catch (error) {
        logger.error({ err: error }, "Refresh-token retention cleanup failed");
    } finally {
        cleanupInProgress = false;
    }
}

export function startRefreshTokenCleanup(): void {
    if (timer) return;
    void removeExpiredRefreshTokens();
    timer = setInterval(() => void removeExpiredRefreshTokens(), DAY_MS);
    timer.unref();
}

export function stopRefreshTokenCleanup(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
}
