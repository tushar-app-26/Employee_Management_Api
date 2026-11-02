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
            const result = await authService.login(req.body, String(res.locals.requestId ?? ""));

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
            const result = await authService.refresh(req.body.refreshToken);

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

    async verifyEmail(req: Request, res: Response, next: NextFunction) {
        try {
            await authService.verifyEmail(req.body.token);
            return ApiResponse.send(res, 200, "Email verified successfully");
        } catch (error) {
            return next(error);
        }
    }

    async verifyEmailLink(req: Request, res: Response, next: NextFunction) {
        try {
            const token = String(req.query.token ?? "");
            if (token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
                return ApiResponse.send(res, 400, "Email verification link is invalid or expired", null, "EMAIL_VERIFICATION_INVALID");
            }
            res.type("html");
            return res.status(200).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Verify employee account</title></head>
<body><main><h1>Verify your email</h1><p>Confirm that you own this email address.</p>
<form method="post" action="/api/v1/auth/verify-email">
<input type="hidden" name="token" value="${token}"><button type="submit">Verify email</button>
</form></main></body></html>`);
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
            const result = await authService.logout(req.body.refreshToken, String(res.locals.requestId ?? ""));

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
            const result = await authService.logoutAll(req.auth!.sub, String(res.locals.requestId ?? ""));
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
            const result = await authService.changePassword(req.auth!.sub, req.body, String(res.locals.requestId ?? ""));
            return ApiResponse.send(res, 200, "Password changed successfully", result);
        } catch (error) {
            return next(error);
        }
    }
}

export const authController = new AuthController();
