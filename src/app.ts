import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CorsOptions } from "cors";

import { config, corsOrigins } from "./config/config.js";
import { requestIdMiddleware } from "./middlewares/request-id.js";
import { ApiResponse } from "./utils/api-response.js";
import { errorHandler } from "./errors/error-handler.js";
import { AppError } from "./errors/app-error.js";
import { checkDatabaseReadiness } from "./config/database.js";
import { createRateLimitStore } from "./config/rate-limit-store.js";
import employeeRoutes from "./routes/employee.routes.js";
import departmentRoutes from "./routes/department.routes.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import documentRoutes from "./routes/document.routes.js";
const app = express();
app.set("trust proxy", config.TRUST_PROXY_HOPS);
const authRateLimitStore = createRateLimitStore("employee-api:auth:");
const apiRateLimitStore = createRateLimitStore("employee-api:api:");

// Attach a unique ID to each request.
app.use(requestIdMiddleware);

// HTTP security headers.
app.use(helmet());

// Allow configured browser origins.
const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
        if (!origin || corsOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true
};

app.use(cors(corsOptions));

// Apply a stricter limit to credential and session-token endpoints.
app.use(
    "/api/v1/auth",
    rateLimit({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        limit: config.AUTH_RATE_LIMIT_MAX_REQUESTS,
        standardHeaders: true,
        legacyHeaders: false,
        ...(authRateLimitStore ? { store: authRateLimitStore } : {}),
        handler: (_req, res) => ApiResponse.send(res, 429, "Too many authentication attempts"),
    }),
);

// Apply the general API rate limit.
app.use(
    "/api/v1",
    rateLimit({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        limit: config.RATE_LIMIT_MAX_REQUESTS,
        standardHeaders: true,
        legacyHeaders: false,
        ...(apiRateLimitStore ? { store: apiRateLimitStore } : {}),
        handler: (_req, res) => {
            return ApiResponse.send(
                res,
                429,
                "Too many requests"
            );
        }
    })
);

// Limit JSON request bodies to 10 KB.
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false, limit: "10kb" }));

if (config.NODE_ENV !== "production") {
    const swaggerDocument = JSON.parse(
        readFileSync(resolve(process.cwd(), "swagger/openapi.json"), "utf8"),
    );
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

app.use("/api/v1/employees", employeeRoutes);
app.use("/api/v1/departments", departmentRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/documents", documentRoutes);

// Liveness only reports whether the HTTP process is running.
app.get("/health/live", (_req, res) => {
    return ApiResponse.send(
        res,
        200,
        "Service is alive",
        { status: "alive" },
    );
});

// Keep the original health URL as a backwards-compatible liveness check.
app.get("/health", (_req, res) => {
    return ApiResponse.send(res, 200, "Service is alive", { status: "alive" });
});

// Readiness confirms the API can reach its required dependencies before receiving traffic.
app.get("/health/ready", async (_req, res, next) => {
    try {
        await checkDatabaseReadiness();
        return ApiResponse.send(res, 200, "Service is ready", { status: "ready" });
    } catch (error) {
        return next(new AppError(
            503,
            "Database is not ready",
            "DATABASE_UNAVAILABLE",
            { cause: error },
        ));
    }
});

// Return a consistent 404 response for unknown routes.
app.use((_req, res) => {
    return ApiResponse.send(
        res,
        404,
        "Route not found"
    );
});

// Keep the error handler after all routes and the 404 handler.
app.use(errorHandler);

export { app };
