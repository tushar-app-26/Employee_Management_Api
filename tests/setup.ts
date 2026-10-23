import dotenv from "dotenv";

dotenv.config({ path: ".env.test", override: true });

// Keep ordinary integration requests below the app's in-memory limiter. The
// dedicated rate-limit test loads an isolated app instance with a limit of 1.
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = "100";
process.env.RATE_LIMIT_MAX_REQUESTS = "100";
process.env.DOCUMENT_STORAGE_DIR = "var/test-private-documents";
process.env.DOCUMENT_STORAGE_DRIVER = "local";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl.includes("employee_management_test")) {
    throw new Error(
        "Refusing to run integration tests: DATABASE_URL must target employee_management_test",
    );
}

if (process.env.NODE_ENV !== "test") {
    throw new Error("Integration tests must run with NODE_ENV=test");
}
