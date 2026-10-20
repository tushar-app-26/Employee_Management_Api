import type { MigrationInterface, QueryRunner } from "typeorm";

export class SyncEmployeeNamesFromUsers1792430000000
    implements MigrationInterface
{
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE employees AS employee
            SET
                first_name = COALESCE(employee.first_name, account.first_name),
                last_name = COALESCE(employee.last_name, account.last_name)
            FROM users AS account
            WHERE employee.user_id = account.id
              AND (
                  employee.first_name IS NULL
                  OR employee.last_name IS NULL
              )
        `);
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Keep copied names on rollback: removing them could discard data that
        // was present on employees before this migration ran.
    }
}
