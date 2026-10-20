
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
    if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
    }

    await AppDataSource.query("SELECT 1");

    console.log("PostgreSQL connection successful");
}
