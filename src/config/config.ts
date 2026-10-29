
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

    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
    DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
    DB_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
    DB_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(10).max(5000).default(200),

    JWT_SECRET: z
        .string()
        .min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(5).default(0),

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

    AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().max(1000).default(10),
    LOGIN_FAILURE_LIMIT: z.coerce.number().int().positive().max(100).default(5),
    LOGIN_FAILURE_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(900),
    DOCUMENT_LINK_LIMIT: z.coerce.number().int().positive().max(1000).default(10),
    DOCUMENT_LINK_WINDOW_SECONDS: z.coerce.number().int().positive().max(3600).default(60),
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(600),
    AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
    INACTIVE_EMPLOYEE_REVIEW_DAYS: z.coerce.number().int().positive().default(2555),
    DOCUMENT_STORAGE_DIR: z.string().min(1).default("var/private-documents"),
    DOCUMENT_MAX_SIZE_MB: z.coerce.number().int().positive().max(25).default(5),
    DOCUMENT_STORAGE_DRIVER: z.enum(["local", "s3"]).default("s3"),
    AWS_REGION: z.string().min(1).default(""),
    AWS_S3_BUCKET: z.string().min(1).default(""),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    S3_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
    REDIS_URL: z.string().default(""),
    REDIS_USERNAME: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TLS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
    REDIS_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    REDIS_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(10).max(5000).default(200),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    DEV_ADMIN_EMAIL: z.string().optional(),
    DEV_ADMIN_PASSWORD: z.string().optional(),
    DEV_ADMIN_FIRST_NAME: z.string().optional(),
    DEV_ADMIN_LAST_NAME: z.string().optional(),
    DEV_HR_EMAIL: z.string().optional(),
    DEV_HR_PASSWORD: z.string().optional(),
    DEV_HR_FIRST_NAME: z.string().optional(),
    DEV_HR_LAST_NAME: z.string().optional(),
});

const result = configSchema.safeParse(process.env);

if (!result.success) {
    console.error(
        "Invalid environment configuration:",
        result.error.flatten().fieldErrors,
    );

    process.exit(1);
}

if (result.data.DOCUMENT_STORAGE_DRIVER === "s3") {
    const missing: string[] = [];
    if (!result.data.AWS_REGION) missing.push("AWS_REGION");
    if (!result.data.AWS_S3_BUCKET) missing.push("AWS_S3_BUCKET");
    if (Boolean(result.data.AWS_ACCESS_KEY_ID) !== Boolean(result.data.AWS_SECRET_ACCESS_KEY)) {
        missing.push("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together");
    }
    if (missing.length) {
        console.error("Invalid environment configuration:", missing);
        process.exit(1);
    }
}

if (result.data.NODE_ENV === "production" && !result.data.REDIS_URL) {
    console.error("Invalid environment configuration:", ["REDIS_URL is required in production"]);
    process.exit(1);
}

export const config = result.data;

export const corsOrigins = config.CORS_ORIGINS
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
