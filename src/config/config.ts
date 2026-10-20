
import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    PORT: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .default(3000),

    DATABASE_URL: z
        .string()
        .min(1, "DATABASE_URL is required"),

    JWT_SECRET: z
        .string()
        .min(32, "JWT_SECRET must be at least 32 characters"),

    JWT_ACCESS_TTL: z.string()
        .regex(/^[1-9]\d*[sm]$/)
        .refine((value) => {
            const match = /^([1-9]\d*)([sm])$/.exec(value);
            return Boolean(match && Number(match[1]) * (match[2] === "m" ? 60 : 1) <= 3600);
        }, "JWT_ACCESS_TTL must be at most one hour")
        .default("15m"),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(7),

    CORS_ORIGINS: z
        .string()
        .default("http://localhost:5173"),

    RATE_LIMIT_WINDOW_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(60000),

    RATE_LIMIT_MAX_REQUESTS: z.coerce
        .number()
        .int()
        .positive()
        .default(30),

    AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().max(100).default(10),
    AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
    INACTIVE_EMPLOYEE_REVIEW_DAYS: z.coerce.number().int().positive().default(2555),
    DOCUMENT_STORAGE_DIR: z.string().min(1).default("var/private-documents"),
    DOCUMENT_MAX_SIZE_MB: z.coerce.number().int().positive().max(25).default(5),
});

const result = configSchema.safeParse(process.env);

if (!result.success) {
    console.error(
        "Invalid environment configuration:",
        result.error.flatten().fieldErrors,
    );

    process.exit(1);
}

export const config = result.data;

export const corsOrigins = config.CORS_ORIGINS
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
