
import type { ErrorRequestHandler } from "express";
import { ApiResponse } from "../utils/api-response.js";
import { AppError } from "./app-error.js";
import multer from "multer";

export const errorHandler: ErrorRequestHandler = (
    error,
    _req,
    res,
    next,
) => {
    if (res.headersSent) {
        return next(error);
    }

    let statusCode = 500;
    let message = "Internal server error";

    const details = error as {
        type?: unknown;
        code?: unknown;
    };

    // Custom application errors
    if (error instanceof AppError) {
        statusCode = error.statusCode;
        message = error.message;
    }

    else if (error instanceof multer.MulterError) {
        statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        message = error.code === "LIMIT_FILE_SIZE"
            ? "Uploaded file exceeds the configured size limit"
            : "Invalid multipart document upload";
    }

    else if (error instanceof Error && error.message === "Document storage is unavailable") {
        statusCode = 503;
        message = "Document storage is temporarily unavailable";
    }

    else if (["ENOSPC", "EACCES", "EIO"].includes(String(details.code))) {
        statusCode = 503;
        message = "Document storage is temporarily unavailable";
    }

    // CORS error
    else if (
        error instanceof Error &&
        error.message === "Origin not allowed by CORS"
    ) {
        statusCode = 403;
        message = "Origin not allowed";
    }

    // Invalid JSON body
    else if (details.type === "entity.parse.failed") {
        statusCode = 400;
        message = "Invalid JSON request body";
    }

    // PostgreSQL unique constraint violation
    else if (details.code === "23505") {
        statusCode = 409;
        message = "A record with this value already exists";
    }

    // PostgreSQL foreign key violation
    else if (details.code === "23503") {
        statusCode = 400;
        message = "Related record does not exist or is still in use";
    }

    // Log only server-side details
    console.error(
        "Request failed:",
        error instanceof Error ? error.name : "UnknownError",
        "Status:",
        statusCode,
    );

    return ApiResponse.send(
        res,
        statusCode,
        message,
    );
};
