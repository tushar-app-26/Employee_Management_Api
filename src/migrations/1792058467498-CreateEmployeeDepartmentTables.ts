import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEmployeeDepartmentTables1792058467498
    implements MigrationInterface
{
    public async up(queryRunner: QueryRunner): Promise<void> {
        const existing: Array<{
            departments: string | null;
            employees: string | null;
        }> = await queryRunner.query(`
            SELECT to_regclass('public.departments') AS departments,
                   to_regclass('public.employees') AS employees
        `);

        if (existing[0]?.departments && existing[0]?.employees) {
            // Support databases created by the former node-pg-migrate runner.
            return;
        }
        if (existing[0]?.departments || existing[0]?.employees) {
            throw new Error(
                "Only one base table exists. Resolve the partial schema before applying this migration.",
            );
        }

        await queryRunner.query(`
            CREATE TABLE departments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name VARCHAR(100) NOT NULL UNIQUE,
                description TEXT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`
            CREATE TABLE employees (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                work_email VARCHAR(255) NOT NULL UNIQUE,
                phone VARCHAR(30) NULL,
                department_id UUID NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
                manager_id UUID NULL REFERENCES employees(id) ON DELETE SET NULL,
                job_title VARCHAR(150) NOT NULL,
                joining_date DATE NOT NULL,
                employment_status VARCHAR(20) NOT NULL DEFAULT 'active',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT employees_employment_status_check
                    CHECK (employment_status IN ('active', 'inactive', 'on_leave', 'terminated')),
                CONSTRAINT employees_manager_not_self_check
                    CHECK (manager_id IS NULL OR manager_id <> id)
            )
        `);
        await queryRunner.query(`CREATE INDEX employees_department_id_index ON employees(department_id)`);
        await queryRunner.query(`CREATE INDEX employees_manager_id_index ON employees(manager_id)`);
        await queryRunner.query(`CREATE INDEX employees_employment_status_index ON employees(employment_status)`);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // This migration can adopt pre-existing tables; dropping them on
        // rollback could destroy data not created by this migration.
    }
}
