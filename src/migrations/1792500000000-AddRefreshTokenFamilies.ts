import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddRefreshTokenFamilies1792500000000
    implements MigrationInterface
{
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE refresh_tokens
            ADD COLUMN family_id UUID
        `);
        // Existing refresh-token rows predate family tracking. Give each
        // existing row its own family; new rotations preserve that family ID.
        await queryRunner.query(`
            UPDATE refresh_tokens
            SET family_id = id
            WHERE family_id IS NULL
        `);
        await queryRunner.query(`
            ALTER TABLE refresh_tokens
            ALTER COLUMN family_id SET NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX idx_refresh_tokens_family_id
            ON refresh_tokens(family_id)
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS idx_refresh_tokens_family_id`);
        await queryRunner.query(`ALTER TABLE refresh_tokens DROP COLUMN family_id`);
    }
}
