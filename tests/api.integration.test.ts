import "reflect-metadata";
import bcrypt from "bcrypt";
import { mkdir, readdir, unlink } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { app } from "../src/app.js";
import { config } from "../src/config/config.js";
import { AppDataSource } from "../src/config/database.js";
import { DepartmentEntity } from "../src/entities/department.entity.js";
import { EmployeeDocumentEntity } from "../src/entities/employee-document.entity.js";
import { EmployeeEntity } from "../src/entities/employee.entity.js";
import { UserEntity, type UserRole } from "../src/entities/user.entity.js";
import { AppError } from "../src/errors/app-error.js";
import { errorHandler } from "../src/errors/error-handler.js";
import { storageDirectory } from "../src/middlewares/document-upload.js";
import { requestIdMiddleware } from "../src/middlewares/request-id.js";
import { employeeService } from "../src/services/employee.service.js";

const password = "CorrectHorseBatteryStaple123!";
const api = "/api/v1";
let storageFilesBeforeTest = new Set<string>();

type Account = {
    user: UserEntity;
    accessToken: string;
    refreshToken: string;
};

async function createUser(role: UserRole = "employee"): Promise<UserEntity> {
    const repository = AppDataSource.getRepository(UserEntity);
    const id = randomUUID();
    return repository.save(repository.create({
        id,
        firstName: `First-${id.slice(0, 6)}`,
        lastName: `Last-${id.slice(0, 6)}`,
        email: `${id}@example.test`,
        passwordHash: await bcrypt.hash(password, 4),
        role,
        isActive: true,
    }));
}

async function login(user: UserEntity): Promise<Account> {
    const response = await request(app)
        .post(`${api}/auth/login`)
        .send({ email: user.email, password });
    expect(response.status).toBe(200);
    return {
        user,
        accessToken: response.body.data.accessToken as string,
        refreshToken: response.body.data.refreshToken as string,
    };
}

async function createDepartment(name = `Department-${randomUUID()}`): Promise<DepartmentEntity> {
    const repository = AppDataSource.getRepository(DepartmentEntity);
    return repository.save(repository.create({ name, description: "Integration test department" }));
}

async function createEmployee(
    departmentId: string,
    options: {
        user?: UserEntity;
        managerId?: string | null;
        email?: string;
        status?: EmployeeEntity["employmentStatus"];
        firstName?: string;
        lastName?: string;
    } = {},
): Promise<EmployeeEntity> {
    const repository = AppDataSource.getRepository(EmployeeEntity);
    const id = randomUUID();
    return repository.save(repository.create({
        id,
        firstName: options.firstName ?? "Test",
        lastName: options.lastName ?? "Employee",
        userId: options.user?.id ?? null,
        user: options.user ?? null,
        workEmail: options.email ?? `${id}@work.example.test`,
        phone: null,
        departmentId,
        managerId: options.managerId ?? null,
        jobTitle: "Test role",
        joiningDate: "2025-01-15",
        employmentStatus: options.status ?? "active",
    }));
}

function asUser(token: string) {
    return { Authorization: `Bearer ${token}` };
}

async function adminAccount(): Promise<Account> {
    return login(await createUser("admin"));
}

beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes("employee_management_test")) {
        throw new Error("Refusing to connect: tests require employee_management_test");
    }
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
});

beforeEach(async () => {
    // Only named application tables are cleared. Roles and permissions remain seeded by migrations.
    await AppDataSource.query(`
        TRUNCATE TABLE employee_documents, audit_logs, refresh_tokens,
            employees, users, departments RESTART IDENTITY CASCADE
    `);
    await mkdir(storageDirectory, { recursive: true });
    storageFilesBeforeTest = new Set(await readdir(storageDirectory));
});

afterEach(async () => {
    const currentFiles = await readdir(storageDirectory).catch(() => []);
    await Promise.all(currentFiles
        .filter((filename) => !storageFilesBeforeTest.has(filename))
        .map((filename) => unlink(resolve(storageDirectory, filename)).catch(() => undefined)));
});

afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
});

describe("mandatory assignment integration scenarios", () => {
    // 1. Successful login and invalid credentials use the real users and refresh-token tables.
    test("login accepts valid credentials and rejects invalid credentials", async () => {
        const user = await createUser();
        const success = await request(app).post(`${api}/auth/login`).send({ email: user.email, password });
        expect(success.status).toBe(200);
        expect(success.body.data.accessToken).toEqual(expect.any(String));

        const failure = await request(app).post(`${api}/auth/login`).send({ email: user.email, password: "wrong-password" });
        expect(failure.status).toBe(401);
        expect(failure.body.message).toBe("Invalid email or password");
    });

    test("login performs bcrypt comparison even when the email is unknown", async () => {
        const compareSpy = vi.spyOn(bcrypt, "compare");
        try {
            const response = await request(app).post(`${api}/auth/login`).send({
                email: `unknown-${randomUUID()}@example.test`,
                password,
            });
            expect(response.status).toBe(401);
            expect(response.body.message).toBe("Invalid email or password");
            expect(compareSpy).toHaveBeenCalledTimes(1);
            expect(compareSpy.mock.calls[0]?.[0]).toBe(password);
            expect(compareSpy.mock.calls[0]?.[1]).toMatch(/^\$2b\$12\$/);
        } finally {
            compareSpy.mockRestore();
        }
    });

    // 2. Public account responses must not contain hashes or plaintext password fields.
    test("registration and login responses never return password hashes", async () => {
        const email = `${randomUUID()}@example.test`;
        const registration = await request(app).post(`${api}/auth/register`).send({
            firstName: "Riya", lastName: "Test", email, password,
        });
        expect(registration.status).toBe(202);
        expect(registration.body.data).toBeNull();
        const user = await AppDataSource.getRepository(UserEntity).findOneByOrFail({ email });
        const signedIn = await request(app).post(`${api}/auth/login`).send({ email: user.email, password });
        const responseText = JSON.stringify([registration.body, signedIn.body]);
        expect(responseText).not.toContain(user.passwordHash);
        expect(responseText).not.toMatch(/passwordHash|password_hash/i);
    });

    test("registration returns the same response for new and existing email addresses", async () => {
        const email = `${randomUUID()}@example.test`;
        const body = { firstName: "Riya", lastName: "Test", email, password };
        const first = await request(app).post(`${api}/auth/register`).send(body);
        const duplicate = await request(app).post(`${api}/auth/register`).send(body);

        expect(first.status).toBe(202);
        expect(duplicate.status).toBe(first.status);
        expect(duplicate.body).toMatchObject({
            statusCode: first.body.statusCode,
            success: first.body.success,
            message: first.body.message,
            data: first.body.data,
        });
        expect(first.body.message).toBe("Registration request accepted");
        expect(await AppDataSource.getRepository(UserEntity).countBy({ email })).toBe(1);
    });

    // 3. Authentication rejects expired JWTs and signatures made with another key.
    test("expired and incorrectly signed JWTs are rejected", async () => {
        const account = await login(await createUser());
        const decoded = jwt.decode(account.accessToken) as jwt.JwtPayload;
        const claims = { sub: account.user.id, role: account.user.role, sid: decoded.sid };
        const expired = jwt.sign(claims, config.JWT_SECRET, {
            expiresIn: -1, issuer: "employee-management-api", audience: "employee-management-client",
        });
        const wrongSignature = jwt.sign(claims, "wrong-secret-with-enough-length-123456", {
            issuer: "employee-management-api", audience: "employee-management-client",
        });

        for (const token of [expired, wrongSignature]) {
            const response = await request(app).get(`${api}/auth/sessions`).set(asUser(token));
            expect(response.status).toBe(401);
        }
    });

    // 4. Refresh rotation stores a replacement and reuse of the prior token invalidates the family.
    test("refresh rotates tokens and rejects reuse of a previously rotated token", async () => {
        const account = await login(await createUser());
        const rotated = await request(app).post(`${api}/auth/refresh`).send({ refreshToken: account.refreshToken });
        expect(rotated.status).toBe(200);
        expect(rotated.body.data.refreshToken).not.toBe(account.refreshToken);

        const reused = await request(app).post(`${api}/auth/refresh`).send({ refreshToken: account.refreshToken });
        expect(reused.status).toBe(401);
        const replacementReuse = await request(app).post(`${api}/auth/refresh`).send({
            refreshToken: rotated.body.data.refreshToken,
        });
        expect(replacementReuse.status).toBe(401);
    });

    // 5. Logout revokes one session; logout-all revokes the remaining user's sessions.
    test("logout and logout-all revoke refresh-token sessions", async () => {
        const user = await createUser();
        const first = await login(user);
        const second = await login(user);
        expect((await request(app).post(`${api}/auth/logout`).send({ refreshToken: first.refreshToken })).status).toBe(200);
        const logoutAll = await request(app).post(`${api}/auth/logout-all`).set(asUser(second.accessToken));
        expect(logoutAll.status).toBe(200);
        const active = await AppDataSource.query(
            `SELECT COUNT(*)::int AS count FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
            [user.id],
        ) as Array<{ count: number }>;
        expect(active[0]?.count).toBe(0);
    });

    // 6. Employees cannot read another employee's private profile.
    test("employee cannot read another employee's restricted profile", async () => {
        const department = await createDepartment();
        const reader = await createUser("employee");
        const target = await createEmployee(department.id);
        const account = await login(reader);
        const response = await request(app).get(`${api}/employees/${target.id}`).set(asUser(account.accessToken));
        expect([403, 404]).toContain(response.status);
    });

    // 7. A manager can see only direct reports, not unrelated employees.
    test("manager access is limited to direct reports", async () => {
        const department = await createDepartment();
        const managerUser = await createUser("manager");
        const managerProfile = await createEmployee(department.id, { user: managerUser });
        const report = await createEmployee(department.id, { managerId: managerProfile.id });
        const outsider = await createEmployee(department.id);
        const account = await login(managerUser);

        const reportResponse = await request(app).get(`${api}/employees/${report.id}`).set(asUser(account.accessToken));
        expect(reportResponse.status).toBe(200);
        const outsiderResponse = await request(app).get(`${api}/employees/${outsider.id}`).set(asUser(account.accessToken));
        expect(outsiderResponse.status).toBe(404);
    });

    // 8. HR has no user:manage permission and cannot grant an admin role.
    test("HR cannot grant an admin role", async () => {
        const hr = await login(await createUser("hr"));
        const employee = await createUser();
        const response = await request(app).patch(`${api}/users/${employee.id}/access`)
            .set(asUser(hr.accessToken)).send({ role: "admin" });
        expect(response.status).toBe(403);
        expect((await AppDataSource.getRepository(UserEntity).findOneByOrFail({ id: employee.id })).role).toBe("employee");
    });

    // 9. Strict body validation prevents employee self-service mass assignment.
    test("employee cannot mass-assign role, salary, or department", async () => {
        const department = await createDepartment();
        const user = await createUser();
        await createEmployee(department.id, { user });
        const account = await login(user);
        const response = await request(app).patch(`${api}/employees/me`).set(asUser(account.accessToken))
            .send({ firstName: "Changed", role: "admin", salary: 999999, departmentId: randomUUID() });
        expect(response.status).toBe(400);
        expect((await AppDataSource.getRepository(UserEntity).findOneByOrFail({ id: user.id })).role).toBe("employee");
    });

    // 10. Protected routes reject callers without a bearer token.
    test("unauthenticated requests cannot access protected endpoints", async () => {
        const response = await request(app).get(`${api}/employees`);
        expect(response.status).toBe(401);
    });

    // 11. The unique work-email constraint is enforced by PostgreSQL and mapped to HTTP 409.
    test("duplicate work emails are rejected by the database", async () => {
        const admin = await adminAccount();
        const department = await createDepartment();
        const existing = await createEmployee(department.id);
        const newUser = await createUser();
        const response = await request(app).post(`${api}/employees`).set(asUser(admin.accessToken)).send({
            userId: newUser.id, workEmail: existing.workEmail, departmentId: department.id,
            jobTitle: "Analyst", joiningDate: "2025-02-01",
        });
        expect(response.status).toBe(409);
    });

    // 12. A nonexistent foreign-key target is handled as a client-safe not-found response.
    test("invalid department foreign keys are handled without creating an employee", async () => {
        const admin = await adminAccount();
        const user = await createUser();
        const response = await request(app).post(`${api}/employees`).set(asUser(admin.accessToken)).send({
            userId: user.id, workEmail: `${randomUUID()}@work.example.test`, departmentId: randomUUID(),
            jobTitle: "Analyst", joiningDate: "2025-02-01",
        });
        expect(response.status).toBe(404);
        expect(await AppDataSource.getRepository(EmployeeEntity).count()).toBe(0);
    });

    // 13. Search strings are bound as parameters and cannot turn into SQL predicates.
    test("SQL injection text does not bypass employee-list filters", async () => {
        const admin = await adminAccount();
        const department = await createDepartment();
        await createEmployee(department.id);
        const response = await request(app).get(`${api}/employees`)
            .set(asUser(admin.accessToken)).query({ search: "%' OR 1=1 --" });
        expect(response.status).toBe(200);
        expect(response.body.data.items).toHaveLength(0);
    });

    // 14. Pagination, filtering, sorting, and the maximum page size are checked together.
    test("employee listing filters, sorts, paginates, and enforces the page-size cap", async () => {
        const admin = await adminAccount();
        const department = await createDepartment();
        const otherDepartment = await createDepartment();
        await createEmployee(department.id, { email: "b@work.example.test" });
        await createEmployee(department.id, { email: "a@work.example.test" });
        await createEmployee(otherDepartment.id, { email: "c@work.example.test" });

        const page = await request(app).get(`${api}/employees`).set(asUser(admin.accessToken))
            .query({ departmentId: department.id, limit: 1, page: 1, sortBy: "workEmail", sortOrder: "asc" });
        expect(page.status).toBe(200);
        expect(page.body.data.items).toHaveLength(1);
        expect(page.body.data.items[0].workEmail).toBe("a@work.example.test");
        expect(page.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });

        const tooLarge = await request(app).get(`${api}/employees`).set(asUser(admin.accessToken)).query({ limit: 101 });
        expect(tooLarge.status).toBe(400);
    });

    // 15. A late unique-key failure rolls back the earlier user-name update in the same transaction.
    test("failed multi-step employee creation rolls back earlier database writes", async () => {
        const admin = await adminAccount();
        const department = await createDepartment();
        const existing = await createEmployee(department.id);
        const user = await createUser();
        const originalFirstName = user.firstName;
        const response = await request(app).post(`${api}/employees`).set(asUser(admin.accessToken)).send({
            userId: user.id, firstName: "Should Roll Back", lastName: "Should Roll Back",
            workEmail: existing.workEmail, departmentId: department.id,
            jobTitle: "Analyst", joiningDate: "2025-02-01",
        });
        expect(response.status).toBe(409);
        expect((await AppDataSource.getRepository(UserEntity).findOneByOrFail({ id: user.id })).firstName).toBe(originalFirstName);
        expect(await AppDataSource.getRepository(EmployeeEntity).countBy({ userId: user.id })).toBe(0);
    });

    // 16. This isolated app instance uses a one-request auth limit so this assertion cannot consume
    // the main app's rate-limit budget for the rest of the integration suite.
    test("repeated authentication requests trigger rate limiting", async () => {
        const previousLimit = process.env.AUTH_RATE_LIMIT_MAX_REQUESTS;
        process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = "1";
        vi.resetModules();
        try {
            const { app: limitedApp } = await import("../src/app.js");
            const first = await request(limitedApp).post(`${api}/auth/login`).send({ email: "invalid", password: "x" });
            const second = await request(limitedApp).post(`${api}/auth/login`).send({ email: "invalid", password: "x" });
            expect(first.status).toBe(400);
            expect(second.status).toBe(429);
        } finally {
            if (previousLimit === undefined) delete process.env.AUTH_RATE_LIMIT_MAX_REQUESTS;
            else process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = previousLimit;
            vi.resetModules();
        }
    });

    // 17. CORS rejects an origin outside the configured allowlist.
    test("untrusted CORS origins are denied", async () => {
        const response = await request(app).get("/health").set("Origin", "https://untrusted.example");
        expect(response.status).toBe(403);
        expect(response.body.message).toBe("Origin not allowed");
    });

    // 18. Error responses do not disclose stack traces, secrets, or internal error details.
    test("error responses omit stack traces and sensitive values", async () => {
        const response = await request(app).post(`${api}/auth/login`)
            .set("Content-Type", "application/json").send("{not-json");
        expect(response.status).toBe(400);
        expect(JSON.stringify(response.body)).not.toMatch(/stack|JWT_SECRET|passwordHash|password_hash/i);
    });

    // 19. Server logs for rejected credentials must not include the submitted password or tokens.
    test("logs do not contain passwords or authentication tokens", async () => {
        const secretPassword = `never-log-${randomUUID()}`;
        const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await request(app).post(`${api}/auth/login`).send({ email: "missing@example.test", password: secretPassword });
            const logs = JSON.stringify(logger.mock.calls);
            expect(logs).not.toContain(secretPassword);
            expect(logs).not.toMatch(/accessToken|refreshToken|Bearer\s/i);
        } finally {
            logger.mockRestore();
        }
    });

    // 20. Employee deactivation revokes refresh sessions and immediately invalidates old access JWTs.
    test("deactivated employee accounts cannot use their revoked session", async () => {
        const department = await createDepartment();
        const employeeUser = await createUser();
        const employee = await createEmployee(department.id, { user: employeeUser });
        const employeeAccount = await login(employeeUser);
        const admin = await adminAccount();
        const deactivated = await request(app).delete(`${api}/employees/${employee.id}`).set(asUser(admin.accessToken));
        expect(deactivated.status).toBe(200);
        const oldToken = await request(app).get(`${api}/employees/me`).set(asUser(employeeAccount.accessToken));
        expect(oldToken.status).toBe(401);
    });

    test("HR may edit employee details but cannot disable their account through PATCH", async () => {
        const department = await createDepartment();
        const hr = await login(await createUser("hr"));
        const employeeUser = await createUser();
        const employee = await createEmployee(department.id, { user: employeeUser });
        const employeeAccount = await login(employeeUser);

        const ordinaryEdit = await request(app).patch(`${api}/employees/${employee.id}`)
            .set(asUser(hr.accessToken)).send({ jobTitle: "Senior Analyst" });
        expect(ordinaryEdit.status).toBe(200);

        const deactivation = await request(app).patch(`${api}/employees/${employee.id}`)
            .set(asUser(hr.accessToken)).send({ employmentStatus: "terminated" });
        expect(deactivation.status).toBe(403);
        expect((await AppDataSource.getRepository(UserEntity).findOneByOrFail({ id: employeeUser.id })).isActive).toBe(true);
        expect((await request(app).get(`${api}/employees/me`).set(asUser(employeeAccount.accessToken))).status).toBe(200);
    });

    test("admins with employee:deactivate can disable an employee and revoke its sessions", async () => {
        const department = await createDepartment();
        const admin = await adminAccount();
        const employeeUser = await createUser();
        const employee = await createEmployee(department.id, { user: employeeUser });
        const employeeAccount = await login(employeeUser);

        const response = await request(app).patch(`${api}/employees/${employee.id}`)
            .set(asUser(admin.accessToken)).send({ employmentStatus: "terminated" });
        expect(response.status).toBe(200);
        expect(response.body.data.employmentStatus).toBe("terminated");
        expect((await AppDataSource.getRepository(UserEntity).findOneByOrFail({ id: employeeUser.id })).isActive).toBe(false);
        expect((await request(app).get(`${api}/employees/me`).set(asUser(employeeAccount.accessToken))).status).toBe(401);
    });

    test("an admin cannot deactivate their own account by changing their employee status", async () => {
        const department = await createDepartment();
        const admin = await login(await createUser("admin"));
        const profile = await createEmployee(department.id, { user: admin.user });

        const response = await request(app).patch(`${api}/employees/${profile.id}`)
            .set(asUser(admin.accessToken)).send({ employmentStatus: "inactive" });
        expect(response.status).toBe(400);
        expect((await AppDataSource.getRepository(UserEntity).findOneByOrFail({ id: admin.user.id })).isActive).toBe(true);
        expect((await AppDataSource.getRepository(EmployeeEntity).findOneByOrFail({ id: profile.id })).employmentStatus).toBe("active");
    });

    test("employee status changes cannot bypass the last-active-admin guard", async () => {
        const department = await createDepartment();
        const lastAdmin = await createUser("admin");
        const profile = await createEmployee(department.id, { user: lastAdmin });

        await expect(employeeService.updateEmployee(
            profile.id,
            { employmentStatus: "terminated" },
            { sub: randomUUID(), role: "admin" },
        )).rejects.toMatchObject({ statusCode: 400 });
        expect((await AppDataSource.getRepository(UserEntity).findOneByOrFail({ id: lastAdmin.id })).isActive).toBe(true);
        expect((await AppDataSource.getRepository(EmployeeEntity).findOneByOrFail({ id: profile.id })).employmentStatus).toBe("active");
    });

    // 21. Invalid JSON input returns the standard structured validation response.
    test("invalid request bodies return a structured 400 response", async () => {
        const response = await request(app).post(`${api}/auth/register`).send({ email: "not-an-email" });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ success: false, message: "Request validation failed" });
        expect(response.body.data).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: "firstName" }),
            expect.objectContaining({ field: "email" }),
        ]));
    });

    // 22. Unmatched paths return the API's standard 404.
    test("unknown routes return 404", async () => {
        const response = await request(app).get("/this-route-does-not-exist");
        expect(response.status).toBe(404);
        expect(response.body.message).toBe("Route not found");
    });

    // 23. The request-ID middleware adds an ID to successful and failed responses.
    test("every response includes a request ID", async () => {
        const healthy = await request(app).get("/health");
        const missing = await request(app).get("/missing-request-id-check");
        for (const response of [healthy, missing]) {
            expect(response.headers["x-request-id"]).toEqual(expect.any(String));
            expect(response.body.requestId).toBe(response.headers["x-request-id"]);
        }
    });

    // 24. The central error handler converts unexpected exceptions into a safe 500 response.
    test("central error handler processes unexpected failures safely", async () => {
        const failingApp = express();
        failingApp.use(requestIdMiddleware);
        failingApp.get("/explode", (_req, _res, next) => next(new Error("private database detail")));
        failingApp.use(errorHandler);
        const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const response = await request(failingApp).get("/explode");
            expect(response.status).toBe(500);
            expect(response.body.message).toBe("Internal server error");
            expect(response.body.code).toBe("INTERNAL_ERROR");
            expect(JSON.stringify(response.body)).not.toContain("private database detail");
            expect(logger.mock.calls[0]?.[1]).toMatchObject({
                requestId: response.headers["x-request-id"],
                statusCode: 500,
                error: { name: "Error", message: "private database detail" },
            });
            expect((logger.mock.calls[0]?.[1] as { error: { stack?: string } }).error.stack).toContain("Error: private database detail");

            const applicationError = express();
            applicationError.use(requestIdMiddleware);
            applicationError.get("/conflict", (_req, _res, next) => next(new AppError(409, "Duplicate employee", "EMPLOYEE_EXISTS")));
            applicationError.use(errorHandler);
            const conflict = await request(applicationError).get("/conflict");
            expect(conflict.status).toBe(409);
            expect(conflict.body.code).toBe("EMPLOYEE_EXISTS");
        } finally {
            logger.mockRestore();
        }
    });

    // 25. A server started with an unreachable PostgreSQL URL exits unsuccessfully instead of serving.
    test("database startup failures are handled without starting the API", () => {
        const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 8_000,
            env: {
                ...process.env,
                NODE_ENV: "test",
                DATABASE_URL: "postgresql://postgres:password@127.0.0.1:1/employee_management_test",
                JWT_SECRET: "test-only-secret-minimum-32-characters-long",
                DB_CONNECT_TIMEOUT_MS: "200",
                DB_RETRY_ATTEMPTS: "3",
                DB_RETRY_BASE_DELAY_MS: "20",
            },
        });
        expect(result.error?.message ?? "").not.toMatch(/timed out/i);
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("retrying in");
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("test-only-secret-minimum-32-characters-long");
    });

    test("liveness is independent of readiness, which checks PostgreSQL", async () => {
        const live = await request(app).get("/health/live");
        const ready = await request(app).get("/health/ready");
        expect(live.status).toBe(200);
        expect(live.body.data.status).toBe("alive");
        expect(ready.status).toBe(200);
        expect(ready.body.data.status).toBe("ready");

        const querySpy = vi.spyOn(AppDataSource, "query").mockRejectedValueOnce(new Error("simulated database timeout"));
        const notReady = await request(app).get("/health/ready");
        querySpy.mockRestore();
        expect(notReady.status).toBe(503);
        expect(notReady.body.code).toBe("DATABASE_UNAVAILABLE");
        expect(notReady.body.message).toBe("Database is not ready");
    });

    test("PostgreSQL pool and query timeouts are configured", () => {
        if (AppDataSource.options.type !== "postgres") throw new Error("Expected PostgreSQL test data source");
        expect(AppDataSource.options.poolSize).toBe(config.DB_POOL_MAX);
        expect(AppDataSource.options.connectTimeoutMS).toBe(config.DB_CONNECT_TIMEOUT_MS);
        expect(AppDataSource.options.extra).toMatchObject({
            max: config.DB_POOL_MAX,
            connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
            query_timeout: config.DB_QUERY_TIMEOUT_MS,
            statement_timeout: config.DB_QUERY_TIMEOUT_MS,
            idle_in_transaction_session_timeout: config.DB_QUERY_TIMEOUT_MS,
        });
    });

    // Rejected uploads must be removed after Multer has written them to disk.
    test("unauthorized document uploads leave no file behind", async () => {
        const department = await createDepartment();
        const employeeUser = await createUser();
        const ownProfile = await createEmployee(department.id, { user: employeeUser });
        const otherProfile = await createEmployee(department.id);
        const account = await login(employeeUser);
        const filesBefore = new Set(await readdir(storageDirectory));

        const response = await request(app)
            .post(`${api}/employees/${otherProfile.id}/documents`)
            .set(asUser(account.accessToken))
            .attach("document", Buffer.from("%PDF-1.7\nvalid test PDF"), {
                filename: "unauthorized.pdf",
                contentType: "application/pdf",
            });

        expect(response.status).toBe(404);
        expect(await readdir(storageDirectory)).toEqual([...filesBefore]);
        expect(await AppDataSource.getRepository(EmployeeDocumentEntity).count()).toBe(0);
        expect(ownProfile.id).not.toBe(otherProfile.id);
    });

    // A permitted upload must retain its file and persist the corresponding database record.
    test("authorized document uploads retain the file and database record", async () => {
        const department = await createDepartment();
        const employeeUser = await createUser();
        const employee = await createEmployee(department.id, { user: employeeUser });
        const account = await login(employeeUser);
        const filesBefore = new Set(await readdir(storageDirectory));

        const response = await request(app)
            .post(`${api}/employees/${employee.id}/documents`)
            .set(asUser(account.accessToken))
            .attach("document", Buffer.from("%PDF-1.7\nvalid test PDF"), {
                filename: "authorized.pdf",
                contentType: "application/pdf",
            });

        expect(response.status).toBe(201);
        const newFiles = (await readdir(storageDirectory)).filter((filename) => !filesBefore.has(filename));
        expect(newFiles).toHaveLength(1);
        expect(response.body.data.originalFilename).toBe("authorized.pdf");
        expect(await AppDataSource.getRepository(EmployeeDocumentEntity).countBy({ employeeId: employee.id })).toBe(1);
    });
});
