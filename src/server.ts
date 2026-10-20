
import "reflect-metadata";

import { app } from "./app.js";
import { config } from "./config/config.js";
import { AppDataSource, checkDatabaseConnection } from "./config/database.js";

async function startServer(): Promise<void> {
    try {
        await checkDatabaseConnection();

        const server = app.listen(config.PORT, () => {
            console.log(`Server running on port ${config.PORT}`);
        });

        const shutdown = (signal: string): void => {
            console.log(`${signal} received. Shutting down...`);

            server.close((error) => {
                if (error) {
                    console.error("HTTP server shutdown failed:", error);
                    process.exitCode = 1;
                }

                void AppDataSource.destroy()
                    .then(() => {
                        console.log("Database connection closed");
                    })
                    .catch((dbError: unknown) => {
                        console.error("Database shutdown failed:", dbError);
                        process.exitCode = 1;
                    });
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
    }
}

void startServer();
