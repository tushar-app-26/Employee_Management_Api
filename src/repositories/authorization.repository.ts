import { AppDataSource } from "../config/database.js";
import type { UserRole } from "../entities/user.entity.js";

export interface AuthenticatedAccount {
    id: string;
    role: UserRole;
}

export async function findActiveAccountForSession(
    userId: string,
    sessionFamilyId: string,
): Promise<AuthenticatedAccount | null> {
    const rows: Array<{ id: string; role_id: UserRole }> = await AppDataSource.query(
        `SELECT account.id, account.role_id
         FROM users AS account
         WHERE account.id = $1
           AND account.is_active = TRUE
           AND EXISTS (
               SELECT 1 FROM refresh_tokens AS session
               WHERE session.user_id = account.id
                 AND session.family_id = $2
                 AND session.revoked_at IS NULL
                 AND session.expires_at > NOW()
           )`,
        [userId, sessionFamilyId],
    );
    const account = rows[0];
    return account ? { id: account.id, role: account.role_id } : null;
}

export async function roleHasAnyPermission(role: UserRole, permissionIds: string[]): Promise<boolean> {
    const rows: Array<{ permission_id: string }> = await AppDataSource.query(
        `SELECT permission_id
         FROM role_permissions
         WHERE role_id = $1 AND permission_id = ANY($2::varchar[])`,
        [role, permissionIds],
    );
    return rows.length > 0;
}
