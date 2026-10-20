import type { Response } from "express";

export class ApiResponse {
    static send<T>(
        res: Response,
        statusCode: number,
        message: string,
        data: T | null = null
    ) {
        return res.status(statusCode).json({
            statusCode,
            success: statusCode >= 200 && statusCode < 300,
            message,
            data,
            timestamp: new Date().toISOString(),
            requestId: res.locals.requestId
        });
    }
}