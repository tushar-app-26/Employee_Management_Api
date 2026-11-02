import type { Request, Response, NextFunction } from "express";
import type { AuthPayload } from "./auth.middleware.js";
import { ApiResponse } from "../utils/api-response.js";
import { roleHasAnyPermission } from "../repositories/authorization.repository.js";

type UserRole = AuthPayload["role"];

export function authorize(...allowedRoles: UserRole[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.auth) {
            return ApiResponse.send(
                res,
                401,
                "Authentication required",
            );
        }

        if (!allowedRoles.includes(req.auth.role)) {
            return ApiResponse.send(
                res,
                403,
                "You do not have permission to perform this action",
            );
        }

        next();
    };
}

/** Require at least one persisted permission granted to the authenticated role. */
export function requirePermission(...permissions: string[]) {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (!req.auth) {
            return ApiResponse.send(res, 401, "Authentication required");
        }

        try {
            const authorized = await roleHasAnyPermission(req.auth.role, permissions);
            if (!authorized) {
                return ApiResponse.send(
                    res,
                    403,
                    "You do not have permission to perform this action",
                );
            }

            return next();
        } catch (error) {
            return next(error);
        }
    };
}
