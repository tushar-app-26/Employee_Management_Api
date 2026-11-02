
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/config.js";
import { ApiResponse } from "../utils/api-response.js";
import { findActiveAccountForSession } from "../repositories/authorization.repository.js";

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
            algorithms: ["HS256"],
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
        const account = await findActiveAccountForSession(decoded.sub, decoded.sid);
        if (!account) {
            return ApiResponse.send(res, 401, "Account is inactive or unavailable");
        }

        req.auth = { sub: account.id, role: account.role };
        return next();
    } catch (error) {
        return next(error);
    }
}
