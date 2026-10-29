import type { Request, Response, NextFunction } from "express";
import { ApiResponse } from "../utils/api-response.js";
import { sessionLifecycleService } from "../services/session-lifecycle.service.js";

export class AdminController {
    async sessionMetrics(_req: Request, res: Response, next: NextFunction) {
        try {
            const metrics = await sessionLifecycleService.getAdminMetrics();
            return ApiResponse.send(res, 200, "Session metrics fetched successfully", metrics);
        } catch (error) {
            return next(error);
        }
    }
}

export const adminController = new AdminController();
