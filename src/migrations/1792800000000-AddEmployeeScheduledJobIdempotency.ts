import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmployeeScheduledJobIdempotency1792800000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE UNIQUE INDEX idx_audit_logs_employee_job_run
            ON audit_logs (action, resource_type, resource_id, request_id)
            WHERE resource_type = 'employee'
              AND action IN (
                  'Engineering employee detected',
                  'Employee phone number missing'
              )
              AND request_id IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_logs_employee_job_run`);
    }
}
