import type { Request, Response, NextFunction } from "express";
import { userService } from "../services/user.service.js";
import { ApiResponse } from "../utils/api-response.js";
import type { PaginationQuery } from "../validators/pagination.validator.js";

export class UserController {
    async getUnlinkedEmployeeUsers(
        _req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        try {
            const users = await userService.getUnlinkedEmployeeUsers(
                res.locals.validatedQuery as PaginationQuery,
            );
            ApiResponse.send(res, 200, "Unlinked employee accounts fetched successfully", users);
        } catch (error) {
            next(error);
        }
    }

    async updateAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await userService.updateAccess(
                req.params.id as string,
                req.body,
                req.auth!.sub,
                String(res.locals.requestId ?? ""),
            );
            if (!result) {
                ApiResponse.send(res, 404, "User not found", null);
                return;
            }
            ApiResponse.send(res, 200, "User access updated successfully", result);
        } catch (error) { next(error); }
    }

    async revokeSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const result = await userService.revokeAllSessions(
                req.params.id as string,
                req.auth!.sub,
                String(res.locals.requestId ?? ""),
            );
            if (!result) {
                ApiResponse.send(res, 404, "User not found", null);
                return;
            }
            ApiResponse.send(res, 200, "User sessions revoked successfully", result);
        } catch (error) { next(error); }
    }
}

export const userController = new UserController();
