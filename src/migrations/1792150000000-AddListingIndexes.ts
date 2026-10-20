import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddListingIndexes1792150000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_employees_first_name ON employees(first_name)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_employees_last_name ON employees(last_name)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_employees_joining_date ON employees(joining_date)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_employees_created_at ON employees(created_at)`);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_employees_first_name_trgm ON employees USING GIN (first_name gin_trgm_ops)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_employees_last_name_trgm ON employees USING GIN (last_name gin_trgm_ops)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_employees_work_email_trgm ON employees USING GIN (work_email gin_trgm_ops)`);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_departments_created_at ON departments(created_at)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_departments_updated_at ON departments(updated_at)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_departments_name_trgm ON departments USING GIN (name gin_trgm_ops)`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_departments_description_trgm ON departments USING GIN (description gin_trgm_ops)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS idx_departments_description_trgm`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_departments_name_trgm`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_departments_updated_at`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_departments_created_at`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_work_email_trgm`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_last_name_trgm`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_first_name_trgm`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_created_at`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_joining_date`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_last_name`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_employees_first_name`);
    }
}
