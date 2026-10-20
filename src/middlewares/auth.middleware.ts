
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/config.js";
import { ApiResponse } from "../utils/api-response.js";
import { AppDataSource } from "../config/database.js";

export interface AuthPayload {
    sub: string;
    role: "admin" | "hr" | "manager" | "employee";
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthPayload;
        }
    }
}

export async function authenticate(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
        return ApiResponse.send(
            res,
            401,
            "Authentication token is required",
        );
    }

    const token = authorization.slice(7).trim();

    if (!token) {
        return ApiResponse.send(res, 401, "Invalid authentication token");
    }

    let decoded: string | jwt.JwtPayload;
    try {
        decoded = jwt.verify(token, config.JWT_SECRET, {
            issuer: "employee-management-api",
            audience: "employee-management-client",
        });
    } catch {
        return ApiResponse.send(
            res,
            401,
            "Invalid or expired authentication token",
        );
    }

    if (
        typeof decoded === "string" ||
        typeof decoded.sub !== "string" ||
        typeof decoded.sid !== "string" ||
        !["admin", "hr", "manager", "employee"].includes(String(decoded.role))
    ) {
        return ApiResponse.send(res, 401, "Invalid authentication token");
    }

    try {
        // Read the current account state and role on each protected request.
        // This immediately invalidates existing access tokens after deactivation
        // or a role change instead of trusting stale JWT role claims.
        const accounts: Array<{ id: string; role_id: AuthPayload["role"] }> = await AppDataSource.query(
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
            [decoded.sub, decoded.sid],
        );
        const account = accounts[0];
        if (!account) {
            return ApiResponse.send(res, 401, "Account is inactive or unavailable");
        }

        req.auth = { sub: account.id, role: account.role_id };
        return next();
    } catch (error) {
        return next(error);
    }
}
