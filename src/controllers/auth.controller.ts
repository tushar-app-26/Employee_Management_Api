import type { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service.js";
import { ApiResponse } from "../utils/api-response.js";
import type { PaginationQuery } from "../validators/pagination.validator.js";

export class AuthController {
    async register(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            await authService.register(req.body);

            // Same status, message, and empty result whether the email was
            // newly registered or already existed.
            return ApiResponse.send(res, 202, "Registration request accepted");
        } catch (error) {
            return next(error);
        }
    }

    async login(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.login(req.body, res.locals.requestId as string | undefined);

            return ApiResponse.send(
                res,
                200,
                "Login successful",
                result,
            );
        } catch (error) {
            return next(error);
        }
    }

    async refresh(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.refresh(req.body.refreshToken, res.locals.requestId as string | undefined);

            return ApiResponse.send(
                res,
                200,
                "Token refreshed successfully",
                result,
            );
        } catch (error) {
            return next(error);
        }
    }

    async logout(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.logout(req.body.refreshToken, res.locals.requestId as string | undefined);

            return ApiResponse.send(
                res,
                200,
                "Logged out successfully",
                result,
            );
        } catch (error) {
            return next(error);
        }
    }

    async logoutAll(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.logoutAll(req.auth!.sub, res.locals.requestId as string | undefined);
            return ApiResponse.send(res, 200, "All sessions revoked", result);
        } catch (error) {
            return next(error);
        }
    }

    async sessions(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.getActiveSessions(
                req.auth!.sub,
                res.locals.validatedQuery as PaginationQuery,
            );
            return ApiResponse.send(res, 200, "Active sessions fetched successfully", result);
        } catch (error) {
            return next(error);
        }
    }

    async sessionHistory(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.getSessionHistory(
                req.auth!.sub,
                res.locals.validatedQuery as PaginationQuery,
            );
            return ApiResponse.send(res, 200, "Session history fetched successfully", result);
        } catch (error) {
            return next(error);
        }
    }

    async sessionById(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.getActiveSession(
                req.auth!.sub,
                req.params.id as string,
            );
            if (!result) {
                return ApiResponse.send(res, 404, "Session not found", null);
            }
            return ApiResponse.send(res, 200, "Session fetched successfully", result);
        } catch (error) {
            return next(error);
        }
    }

    async revokeSession(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const revoked = await authService.revokeSession(
                req.auth!.sub,
                req.params.id as string,
                res.locals.requestId as string | undefined,
            );
            if (!revoked) {
                return ApiResponse.send(res, 404, "Session not found", null);
            }
            return ApiResponse.send(res, 200, "Session revoked successfully", { revoked: true });
        } catch (error) {
            return next(error);
        }
    }

    async changePassword(
        req: Request,
        res: Response,
        next: NextFunction,
    ) {
        try {
            const result = await authService.changePassword(req.auth!.sub, req.body, res.locals.requestId as string | undefined);
            return ApiResponse.send(res, 200, "Password changed successfully", result);
        } catch (error) {
            return next(error);
        }
    }
}

export const authController = new AuthController();
