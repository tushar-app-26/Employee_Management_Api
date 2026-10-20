import "reflect-metadata";
import { AppDataSource } from "../config/database.js";
import { config } from "../config/config.js";

async function reportRetentionCandidates(): Promise<void> {
    try {
        await AppDataSource.initialize();
        const employees: Array<{ count: string }> = await AppDataSource.query(
            `SELECT COUNT(*)::text AS count
             FROM employees
             WHERE employment_status IN ('inactive', 'terminated')
               AND updated_at < NOW() - ($1::int * INTERVAL '1 day')`,
            [config.INACTIVE_EMPLOYEE_REVIEW_DAYS],
        );
        console.log(`${employees[0]?.count ?? "0"} inactive/terminated employee records are past the ${config.INACTIVE_EMPLOYEE_REVIEW_DAYS}-day review interval. No employee data was deleted.`);
    } catch {
        console.error("Could not report retention candidates. Check the database connection and migrations.");
        process.exitCode = 1;
    } finally {
        if (AppDataSource.isInitialized) await AppDataSource.destroy();
    }
}

void reportRetentionCandidates();
