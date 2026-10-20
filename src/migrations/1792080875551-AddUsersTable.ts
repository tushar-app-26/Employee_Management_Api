import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddUsersTable1792080875551
    implements MigrationInterface
{
    public async up(queryRunner: QueryRunner): Promise<void> {
        const result: Array<{ table_name: string | null }> =
            await queryRunner.query(`
                SELECT to_regclass('public.users') AS table_name
            `);

        if (result[0]?.table_name) {
            console.log(
                "Users table already exists. Skipping table creation."
            );
            return;
        }

        await queryRunner.query(`
            CREATE TABLE users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL DEFAULT 'employee'
                    CHECK (
                        role IN ('admin', 'hr', 'manager', 'employee')
                    ),
                employee_id UUID UNIQUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_users_employee
                    FOREIGN KEY (employee_id)
                    REFERENCES employees(id)
                    ON DELETE SET NULL
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Existing user data ko protect karne ke liye
        // rollback par users table drop nahi karenge.
        console.log(
            "Users table rollback skipped to protect existing data."
        );
    }
}
