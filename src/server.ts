
import "reflect-metadata";

import { app } from "./app.js";
import { config } from "./config/config.js";
import { AppDataSource, checkDatabaseConnection } from "./config/database.js";
import { closeRateLimitRedis, connectRateLimitRedis } from "./config/rate-limit-store.js";

async function startServer(): Promise<void> {
    try {
        await connectRateLimitRedis();
        await checkDatabaseConnection();

        const server = app.listen(config.PORT, () => {
            console.log(`Server running on port ${config.PORT}`);
        });

        const shutdown = (signal: string): void => {
            console.log(`${signal} received. Shutting down...`);
            const forcedExitTimer = setTimeout(() => {
                console.error("Graceful shutdown timed out; forcing process exit");
                process.exit(1);
            }, config.SHUTDOWN_TIMEOUT_MS);
            forcedExitTimer.unref();

            server.close((error) => {
                if (error) {
                    console.error("HTTP server shutdown failed:", error);
                    process.exitCode = 1;
                }

                void Promise.all([AppDataSource.destroy(), closeRateLimitRedis()])
                    .then(() => console.log("Database and Redis connections closed"))
                    .catch((shutdownError: unknown) => {
                        console.error("Dependency shutdown failed:", shutdownError);
                        process.exitCode = 1;
                    })
                    .finally(() => clearTimeout(forcedExitTimer));
            });
        };

        process.once("SIGINT", () => shutdown("SIGINT"));
        process.once("SIGTERM", () => shutdown("SIGTERM"));
    } catch (error) {
        console.error("Application startup failed:", error);
        process.exitCode = 1;

        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy().catch(() => undefined);
        }
        await closeRateLimitRedis().catch(() => undefined);
    }
}

void startServer();
