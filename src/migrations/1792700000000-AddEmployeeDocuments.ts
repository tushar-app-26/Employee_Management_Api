import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmployeeDocuments1792700000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE employee_documents (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                uploaded_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
                original_filename VARCHAR(255) NOT NULL,
                storage_filename VARCHAR(100) NOT NULL UNIQUE,
                mime_type VARCHAR(100) NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png', 'image/jpeg')),
                size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`CREATE INDEX idx_employee_documents_employee_created ON employee_documents(employee_id, created_at DESC)`);
        await queryRunner.query(`
            INSERT INTO permissions (id, description) VALUES
                ('document:list', 'List documents within the caller permitted employee scope'),
                ('document:upload', 'Upload documents within the caller permitted employee scope'),
                ('document:download', 'Generate short-lived links for permitted employee documents'),
                ('document:delete', 'Delete employee documents under the retention policy')
        `);
        await queryRunner.query(`
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT role_id, permission_id FROM (VALUES
                ('admin', 'document:list'), ('admin', 'document:upload'), ('admin', 'document:download'), ('admin', 'document:delete'),
                ('hr', 'document:list'), ('hr', 'document:upload'), ('hr', 'document:download'), ('hr', 'document:delete'),
                ('manager', 'document:list'), ('manager', 'document:upload'), ('manager', 'document:download'),
                ('employee', 'document:list'), ('employee', 'document:upload'), ('employee', 'document:download')
            ) AS grants(role_id, permission_id)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM role_permissions WHERE permission_id IN ('document:list', 'document:upload', 'document:download', 'document:delete')`);
        await queryRunner.query(`DELETE FROM permissions WHERE id IN ('document:list', 'document:upload', 'document:download', 'document:delete')`);
        await queryRunner.query(`DROP TABLE IF EXISTS employee_documents`);
    }
}
