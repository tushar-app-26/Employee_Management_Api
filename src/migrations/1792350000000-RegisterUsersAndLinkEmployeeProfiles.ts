import type { MigrationInterface, QueryRunner } from "typeorm";

export class RegisterUsersAndLinkEmployeeProfiles1792350000000
    implements MigrationInterface
{
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS first_name VARCHAR(100),
            ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)
        `);

        await queryRunner.query(`
            ALTER TABLE employees
            ADD COLUMN IF NOT EXISTS user_id UUID
        `);

        // Preserve any links from the previous users.employee_id design.
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'users'
                      AND column_name = 'employee_id'
                ) THEN
                    UPDATE employees e
                    SET user_id = u.id
                    FROM users u
                    WHERE u.employee_id = e.id
                      AND e.user_id IS NULL;

                    UPDATE users u
                    SET first_name = e.first_name,
                        last_name = e.last_name
                    FROM employees e
                    WHERE e.user_id = u.id
                      AND u.first_name IS NULL
                      AND u.last_name IS NULL;
                END IF;
            END $$
        `);

        // Existing employee names remain as a legacy fallback so no current
        // employee data is deleted. New profiles use the linked users row.
        await queryRunner.query(`
            ALTER TABLE employees
            ALTER COLUMN first_name DROP NOT NULL,
            ALTER COLUMN last_name DROP NOT NULL
        `);

        await queryRunner.query(`
            DO $$
            DECLARE constraint_name TEXT;
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'users'
                      AND column_name = 'employee_id'
                ) THEN
                    FOR constraint_name IN
                        SELECT c.conname
                        FROM pg_constraint c
                        WHERE c.conrelid = 'users'::regclass
                          AND c.contype IN ('f', 'u')
                          AND pg_get_constraintdef(c.oid) LIKE '%employee_id%'
                    LOOP
                        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', constraint_name);
                    END LOOP;

                    ALTER TABLE users DROP COLUMN employee_id;
                END IF;
            END $$
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_user_id
            ON employees(user_id)
        `);
        await queryRunner.query(`
            ALTER TABLE employees
            ADD CONSTRAINT fk_employees_user
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        `);

        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_users_first_name_trgm
            ON users USING GIN (first_name gin_trgm_ops)
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_users_last_name_trgm
            ON users USING GIN (last_name gin_trgm_ops)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restore the previous relationship while retaining user names and
        // legacy employee names so a rollback never discards profile data.
        await queryRunner.query(`ALTER TABLE users ADD COLUMN employee_id UUID`);
        await queryRunner.query(`
            UPDATE users u
            SET employee_id = e.id
            FROM employees e
            WHERE e.user_id = u.id
        `);
        await queryRunner.query(`
            ALTER TABLE users
            ADD CONSTRAINT uq_users_employee_id UNIQUE (employee_id)
        `);
        await queryRunner.query(`
            ALTER TABLE users
            ADD CONSTRAINT fk_users_employee
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
        `);
        await queryRunner.query(`ALTER TABLE employees DROP CONSTRAINT fk_employees_user`);
        await queryRunner.query(`DROP INDEX IF EXISTS uq_employees_user_id`);
        await queryRunner.query(`ALTER TABLE employees DROP COLUMN user_id`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_users_first_name_trgm`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_users_last_name_trgm`);
    }
}
