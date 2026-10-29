
import "reflect-metadata";

import { app } from "./app.js";
import { config } from "./config/config.js";
import { AppDataSource, checkDatabaseConnection } from "./config/database.js";
import { closeRateLimitRedis, connectRateLimitRedis } from "./config/rate-limit-store.js";
import { startEmployeeJobs, stopEmployeeJobs } from "./jobs/employee-jobs.scheduler.js";
import { sessionLifecycleService } from "./services/session-lifecycle.service.js";

async function startServer(): Promise<void> {
    try {
        await connectRateLimitRedis();
        await checkDatabaseConnection();
        await sessionLifecycleService.start();
        startEmployeeJobs();

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
            stopEmployeeJobs();

            server.close((error) => {
                if (error) {
                    console.error("HTTP server shutdown failed:", error);
                    process.exitCode = 1;
                }

                void Promise.all([sessionLifecycleService.stop(), AppDataSource.destroy(), closeRateLimitRedis()])
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
        await sessionLifecycleService.stop().catch(() => undefined);
        await closeRateLimitRedis().catch(() => undefined);
    }
}

void startServer();
