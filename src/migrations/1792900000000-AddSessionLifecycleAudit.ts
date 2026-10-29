import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddSessionLifecycleAudit1792900000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE session_lifecycle_events (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                event_key VARCHAR(180) NOT NULL UNIQUE,
                user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
                session_id UUID NOT NULL,
                event_type VARCHAR(40) NOT NULL CHECK (event_type IN (
                    'SESSION_CREATED', 'SESSION_EXPIRED', 'SESSION_REVOKED',
                    'LOGOUT', 'REFRESH_TOKEN_REUSE_DETECTED'
                )),
                occurred_at TIMESTAMPTZ NOT NULL,
                processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                processing_status VARCHAR(20) NOT NULL DEFAULT 'processed'
                    CHECK (processing_status IN ('processed', 'reconciled')),
                correlation_id VARCHAR(100) NULL,
                details JSONB NOT NULL DEFAULT '{}'::jsonb
            )
        `);
        await queryRunner.query(`
            CREATE INDEX idx_session_lifecycle_user_history
            ON session_lifecycle_events(user_id, occurred_at DESC)
        `);
        await queryRunner.query(`
            CREATE INDEX idx_session_lifecycle_type_date
            ON session_lifecycle_events(event_type, occurred_at DESC)
        `);
        await queryRunner.query(`
            CREATE TABLE session_daily_summaries (
                summary_date DATE PRIMARY KEY,
                expired_sessions INTEGER NOT NULL DEFAULT 0,
                manually_revoked_sessions INTEGER NOT NULL DEFAULT 0,
                refresh_token_reuse_detections INTEGER NOT NULL DEFAULT 0,
                generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await queryRunner.query(`
            INSERT INTO permissions (id, description)
            VALUES ('session:metrics', 'View aggregate session lifecycle metrics')
            ON CONFLICT (id) DO NOTHING
        `);
        await queryRunner.query(`
            INSERT INTO role_permissions (role_id, permission_id)
            VALUES ('admin', 'session:metrics')
            ON CONFLICT DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM role_permissions WHERE permission_id = 'session:metrics'`);
        await queryRunner.query(`DELETE FROM permissions WHERE id = 'session:metrics'`);
        await queryRunner.query(`DROP TABLE IF EXISTS session_daily_summaries`);
        await queryRunner.query(`DROP TABLE IF EXISTS session_lifecycle_events`);
    }
}
