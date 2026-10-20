import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddPermissionsAuditAndAccountStatus1792600000000
    implements MigrationInterface
{
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE roles (
                id VARCHAR(20) PRIMARY KEY,
                name VARCHAR(50) NOT NULL UNIQUE,
                description TEXT NOT NULL
            )
        `);
        await queryRunner.query(`
            CREATE TABLE permissions (
                id VARCHAR(80) PRIMARY KEY,
                description TEXT NOT NULL
            )
        `);
        await queryRunner.query(`
            CREATE TABLE role_permissions (
                role_id VARCHAR(20) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                permission_id VARCHAR(80) NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
                PRIMARY KEY (role_id, permission_id)
            )
        `);

        await queryRunner.query(`
            INSERT INTO roles (id, name, description) VALUES
                ('admin', 'Administrator', 'Full system administration'),
                ('hr', 'Human Resources', 'Manage employee and department records'),
                ('manager', 'Manager', 'Manage assigned direct reports'),
                ('employee', 'Employee', 'Access own employment profile')
        `);
        await queryRunner.query(`
            INSERT INTO permissions (id, description) VALUES
                ('employee:list', 'List employees within the caller permitted scope'),
                ('employee:read:any', 'Read any employee profile'),
                ('employee:read:reports', 'Read assigned direct reports'),
                ('employee:read:self', 'Read own employment profile'),
                ('employee:create', 'Create an employment profile'),
                ('employee:update:any', 'Update any employment profile'),
                ('employee:update:reports', 'Update permitted fields for direct reports'),
                ('employee:update:self', 'Update permitted fields on own profile'),
                ('employee:deactivate', 'Deactivate an employee account and profile'),
                ('employee:export:self', 'Export own employment profile'),
                ('employee:link-account', 'Link a registered employee account to a profile'),
                ('department:read', 'Read department directory'),
                ('department:manage', 'Create, update, or delete departments'),
                ('user:manage', 'Change account roles or deactivate accounts'),
                ('user:read-unlinked', 'List employee accounts without a profile')
        `);
        await queryRunner.query(`
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT role_id, permission_id
            FROM (VALUES
                ('admin', 'employee:list'), ('admin', 'employee:read:any'),
                ('admin', 'employee:create'), ('admin', 'employee:update:any'),
                ('admin', 'employee:deactivate'), ('admin', 'employee:link-account'),
                ('admin', 'employee:export:self'), ('admin', 'employee:read:self'),
                ('admin', 'employee:update:self'), ('admin', 'department:read'),
                ('admin', 'department:manage'), ('admin', 'user:manage'),
                ('admin', 'user:read-unlinked'),
                ('hr', 'employee:list'), ('hr', 'employee:read:any'),
                ('hr', 'employee:create'), ('hr', 'employee:update:any'),
                ('hr', 'employee:link-account'), ('hr', 'employee:export:self'),
                ('hr', 'employee:read:self'), ('hr', 'employee:update:self'),
                ('hr', 'department:read'), ('hr', 'department:manage'),
                ('hr', 'user:read-unlinked'),
                ('manager', 'employee:list'), ('manager', 'employee:read:reports'),
                ('manager', 'employee:update:reports'), ('manager', 'employee:read:self'),
                ('manager', 'employee:update:self'), ('manager', 'employee:export:self'),
                ('manager', 'department:read'),
                ('employee', 'employee:read:self'), ('employee', 'employee:update:self'),
                ('employee', 'employee:export:self'), ('employee', 'department:read')
            ) AS grants(role_id, permission_id)
        `);

        await queryRunner.query(`
            ALTER TABLE users RENAME COLUMN role TO role_id
        `);
        await queryRunner.query(`
            ALTER TABLE users ALTER COLUMN role_id DROP DEFAULT
        `);
        await queryRunner.query(`
            DO $$
            DECLARE item RECORD;
            BEGIN
                FOR item IN
                    SELECT conname FROM pg_constraint
                    WHERE conrelid = 'users'::regclass
                      AND contype = 'c'
                      AND pg_get_constraintdef(oid) ILIKE '%role_id%'
                LOOP
                    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', item.conname);
                END LOOP;
            END $$
        `);
        await queryRunner.query(`
            ALTER TABLE users
                ADD CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id),
                ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE
        `);
        await queryRunner.query(`ALTER TABLE users ALTER COLUMN role_id SET DEFAULT 'employee'`);
        await queryRunner.query(`CREATE INDEX idx_users_role_id ON users(role_id)`);
        await queryRunner.query(`CREATE INDEX idx_role_permissions_permission_id ON role_permissions(permission_id)`);
        await queryRunner.query(`CREATE INDEX idx_refresh_tokens_active_family ON refresh_tokens(user_id, family_id, expires_at) WHERE revoked_at IS NULL`);

        await queryRunner.query(`
            CREATE TABLE audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
                action VARCHAR(100) NOT NULL,
                resource_type VARCHAR(80) NOT NULL,
                resource_id VARCHAR(100) NULL,
                details JSONB NOT NULL DEFAULT '{}'::jsonb,
                request_id VARCHAR(100) NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at)`);
        await queryRunner.query(`CREATE INDEX idx_audit_logs_actor_created_at ON audit_logs(actor_user_id, created_at)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS audit_logs`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_role_permissions_permission_id`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_users_role_id`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_refresh_tokens_active_family`);
        await queryRunner.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS fk_users_role`);
        await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS is_active`);
        await queryRunner.query(`ALTER TABLE users RENAME COLUMN role_id TO role`);
        await queryRunner.query(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'employee'`);
        await queryRunner.query(`DROP TABLE IF EXISTS role_permissions`);
        await queryRunner.query(`DROP TABLE IF EXISTS permissions`);
        await queryRunner.query(`DROP TABLE IF EXISTS roles`);
    }
}
