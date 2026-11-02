import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddEmailVerification1793000000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE users
                ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT TRUE,
                ADD COLUMN email_verification_token_hash VARCHAR(64) NULL,
                ADD COLUMN email_verification_expires_at TIMESTAMPTZ NULL
        `);
        await queryRunner.query(`ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE`);
        await queryRunner.query(`CREATE INDEX idx_users_email_verification_expiry ON users(email_verification_expires_at) WHERE email_verified = FALSE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS idx_users_email_verification_expiry`);
        await queryRunner.query(`
            ALTER TABLE users
                DROP COLUMN IF EXISTS email_verification_expires_at,
                DROP COLUMN IF EXISTS email_verification_token_hash,
                DROP COLUMN IF EXISTS email_verified
        `);
    }
}
