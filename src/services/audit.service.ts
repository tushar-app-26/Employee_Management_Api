import type { EntityManager } from "typeorm";
import { AppDataSource } from "../config/database.js";

export interface AuditEvent {
    actorUserId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    requestId?: string | null;
    details?: Record<string, unknown>;
}

export class AuditService {
    async record(event: AuditEvent, manager?: EntityManager): Promise<void> {
        const query = `
            INSERT INTO audit_logs
                (actor_user_id, action, resource_type, resource_id, details, request_id)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        `;
        const values = [
            event.actorUserId,
            event.action,
            event.resourceType,
            event.resourceId ?? null,
            JSON.stringify(event.details ?? {}),
            event.requestId ?? null,
        ];

        if (manager) {
            await manager.query(query, values);
        } else {
            await AppDataSource.query(query, values);
        }
    }

    async recordOnce(event: AuditEvent, manager?: EntityManager): Promise<void> {
        const query = `
            INSERT INTO audit_logs
                (actor_user_id, action, resource_type, resource_id, details, request_id)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            ON CONFLICT DO NOTHING
        `;
        const values = [
            event.actorUserId,
            event.action,
            event.resourceType,
            event.resourceId ?? null,
            JSON.stringify(event.details ?? {}),
            event.requestId ?? null,
        ];

        if (manager) {
            await manager.query(query, values);
        } else {
            await AppDataSource.query(query, values);
        }
    }
}

export const auditService = new AuditService();
