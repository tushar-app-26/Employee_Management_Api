
import type { ErrorRequestHandler } from "express";
import { ApiResponse } from "../utils/api-response.js";
import { AppError } from "./app-error.js";
import multer from "multer";

export const errorHandler: ErrorRequestHandler = (
    error,
    req,
    res,
    next,
) => {
    if (res.headersSent) {
        return next(error);
    }

    let statusCode = 500;
    let message = "Internal server error";
    let code = "INTERNAL_ERROR";

    const details = error as {
        type?: unknown;
        code?: unknown;
    };

    // Custom application errors
    if (error instanceof AppError) {
        statusCode = error.statusCode;
        message = error.message;
        code = error.code;
    }

    else if (error instanceof multer.MulterError) {
        statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        code = error.code === "LIMIT_FILE_SIZE" ? "UPLOAD_TOO_LARGE" : "INVALID_UPLOAD";
        message = error.code === "LIMIT_FILE_SIZE"
            ? "Uploaded file exceeds the configured size limit"
            : "Invalid multipart document upload";
    }

    else if (error instanceof Error && error.message === "Document storage is unavailable") {
        statusCode = 503;
        code = "STORAGE_UNAVAILABLE";
        message = "Document storage is temporarily unavailable";
    }

    else if (["ENOSPC", "EACCES", "EIO"].includes(String(details.code))) {
        statusCode = 503;
        code = "STORAGE_UNAVAILABLE";
        message = "Document storage is temporarily unavailable";
    }

    // CORS error
    else if (
        error instanceof Error &&
        error.message === "Origin not allowed by CORS"
    ) {
        statusCode = 403;
        code = "CORS_ORIGIN_DENIED";
        message = "Origin not allowed";
    }

    // Invalid JSON body
    else if (details.type === "entity.parse.failed") {
        statusCode = 400;
        code = "INVALID_JSON";
        message = "Invalid JSON request body";
    }

    // PostgreSQL unique constraint violation
    else if (details.code === "23505") {
        statusCode = 409;
        code = "DUPLICATE_RECORD";
        message = "A record with this value already exists";
    }

    // PostgreSQL foreign key violation
    else if (details.code === "23503") {
        statusCode = 400;
        code = "INVALID_REFERENCE";
        message = "Related record does not exist or is still in use";
    }

    const requestId = String(res.locals.requestId ?? req.header("x-request-id") ?? "unavailable");
    console.error("Request failed", {
        requestId,
        statusCode,
        error: serializeError(error),
    });

    return ApiResponse.send(
        res,
        statusCode,
        message,
        null,
        code,
    );
};

function serializeError(error: unknown, depth = 0): Record<string, unknown> {
    if (depth > 4) return { message: "Error cause depth limit reached" };
    if (!(error instanceof Error)) {
        return { name: "UnknownError", message: String(error) };
    }

    const errorWithCode = error as Error & { code?: unknown };
    const serialized: Record<string, unknown> = {
        name: error.name,
        message: error.message,
        stack: error.stack,
    };
    if (typeof errorWithCode.code === "string") serialized.code = errorWithCode.code;
    if (error.cause !== undefined) serialized.cause = serializeError(error.cause, depth + 1);
    return serialized;
}
