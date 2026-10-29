
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/config.js";
import { ApiResponse } from "../utils/api-response.js";
import { findActiveAccountForSession } from "../repositories/authorization.repository.js";
import { sessionService } from "../services/session.service.js";

export interface AuthPayload {
    sub: string;
    role: "admin" | "hr" | "manager" | "employee";
    sid: string;
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
        return ApiResponse.send(
            res,
            401,
            "Invalid authentication token",
        );
    }

    let decoded: string | jwt.JwtPayload;

    try {
        decoded = jwt.verify(token, config.JWT_SECRET, {
            algorithms: ["HS256"],
            issuer: "employee-management-api",
            audience: "employee-management-client",
            // Keep expiry strict by default; deployments may allow up to five seconds for clock drift.
            clockTolerance: config.JWT_CLOCK_TOLERANCE_SECONDS,
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
        !["admin", "hr", "manager", "employee"].includes(
            String(decoded.role),
        )
    ) {
        return ApiResponse.send(
            res,
            401,
            "Invalid authentication token",
        );
    }

    try {
        const account = await sessionService.getAccount(
            decoded.sid,
            decoded.sub,
            () =>
                findActiveAccountForSession(
                    decoded.sub as string,
                    decoded.sid as string,
                ),
        );

        if (!account) {
            return ApiResponse.send(
                res,
                401,
                "Account is inactive or session is unavailable",
            );
        }

        req.auth = {
            sub: account.id,
            role: account.role,
            sid: decoded.sid,
        };

        return next();
    } catch (error) {
        return next(error);
    }
}
