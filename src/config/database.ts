
import { DataSource } from "typeorm";
import { config } from "./config.js";

import { DepartmentEntity } from "../entities/department.entity.js";
import { EmployeeEntity } from "../entities/employee.entity.js";
import { UserEntity } from "../entities/user.entity.js";
import { RefreshTokenEntity } from "../entities/refresh-token.entity.js";
import { EmployeeDocumentEntity } from "../entities/employee-document.entity.js";
export const AppDataSource = new DataSource({
    type: "postgres",
    url: config.DATABASE_URL,
    poolSize: config.DB_POOL_MAX,
    connectTimeoutMS: config.DB_CONNECT_TIMEOUT_MS,
    extra: {
        max: config.DB_POOL_MAX,
        connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
        query_timeout: config.DB_QUERY_TIMEOUT_MS,
        statement_timeout: config.DB_QUERY_TIMEOUT_MS,
        idle_in_transaction_session_timeout: config.DB_QUERY_TIMEOUT_MS,
    },

    entities: [
        DepartmentEntity,
        EmployeeEntity,
        UserEntity,
        RefreshTokenEntity,
        EmployeeDocumentEntity,
    ],

    // Existing database schema ko automatically change nahi karna.
    synchronize: false,

    // Migrations ko automatically run nahi karna.
    migrationsRun: false,

    // TypeORM migration files ka location.
    migrations: ["src/migrations/*.ts"],

    // TypeORM query logs can include password hashes and refresh-token hashes
    // in bound parameters; keep them disabled in every environment.
    logging: false,
});

export async function checkDatabaseConnection(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.DB_RETRY_ATTEMPTS; attempt += 1) {
        try {
            if (!AppDataSource.isInitialized) {
                await AppDataSource.initialize();
            }
            await AppDataSource.query("SELECT 1");
            console.log("PostgreSQL connection successful");
            return;
        } catch (error) {
            lastError = error;
            if (AppDataSource.isInitialized) {
                await AppDataSource.destroy().catch(() => undefined);
            }

            if (attempt < config.DB_RETRY_ATTEMPTS) {
                const exponentialDelay = config.DB_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
                const jitter = Math.floor(Math.random() * exponentialDelay);
                const delayMs = exponentialDelay + jitter;
                console.warn(`Database connection attempt ${attempt} failed; retrying in ${delayMs} ms`);
                await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
            }
        }
    }

    throw lastError;
}

export async function checkDatabaseReadiness(): Promise<void> {
    if (!AppDataSource.isInitialized) {
        throw new Error("Database connection has not been initialized");
    }
    await AppDataSource.query("SELECT 1");
}
