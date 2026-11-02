import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddRefreshTokenReplayGrace1793100000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE refresh_tokens
                ADD COLUMN replay_token_ciphertext TEXT NULL,
                ADD COLUMN replay_grace_expires_at TIMESTAMPTZ NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE refresh_tokens
                DROP COLUMN IF EXISTS replay_grace_expires_at,
                DROP COLUMN IF EXISTS replay_token_ciphertext
        `);
    }
}
