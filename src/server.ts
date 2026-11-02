
import "reflect-metadata";

import { app } from "./app.js";
import { config } from "./config/config.js";
import { AppDataSource, checkDatabaseConnection } from "./config/database.js";
import { closeRateLimitRedis, connectRateLimitRedis } from "./config/rate-limit-store.js";
import { logger } from "./utils/logger.js";
import { startRefreshTokenCleanup, stopRefreshTokenCleanup } from "./jobs/refresh-token-cleanup.js";

async function startServer(): Promise<void> {
    try {
        await connectRateLimitRedis();
        await checkDatabaseConnection();
        startRefreshTokenCleanup();

        const server = app.listen(config.PORT, () => {
            logger.info({ port: config.PORT }, "Server listening");
        });

        const shutdown = (signal: string): void => {
            logger.info({ signal }, "Shutdown requested");
            const forcedExitTimer = setTimeout(() => {
                logger.fatal("Graceful shutdown timed out; forcing process exit");
                process.exit(1);
            }, config.SHUTDOWN_TIMEOUT_MS);
            stopRefreshTokenCleanup();
            forcedExitTimer.unref();

            server.close((error) => {
                if (error) {
                    logger.error({ err: error }, "HTTP server shutdown failed");
                    process.exitCode = 1;
                }

                void Promise.all([AppDataSource.destroy(), closeRateLimitRedis()])
                    .then(() => logger.info("Database and Redis connections closed"))
                    .catch((shutdownError: unknown) => {
                        logger.error({ err: shutdownError }, "Dependency shutdown failed");
                        process.exitCode = 1;
                    })
                    .finally(() => clearTimeout(forcedExitTimer));
            });
        };

        process.once("SIGINT", () => shutdown("SIGINT"));
        process.once("SIGTERM", () => shutdown("SIGTERM"));
    } catch (error) {
        logger.fatal({ err: error }, "Application startup failed");
        process.exitCode = 1;

        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy().catch(() => undefined);
        }
        await closeRateLimitRedis().catch(() => undefined);
    }
}

void startServer();
