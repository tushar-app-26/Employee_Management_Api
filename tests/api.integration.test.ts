import "reflect-metadata";
import bcrypt from "bcrypt";
import { mkdir, readdir, unlink } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
import { RefreshTokenEntity } from "../src/entities/refresh-token.entity.js";
import { AppError } from "../src/errors/app-error.js";
import { errorHandler } from "../src/errors/error-handler.js";
import { storageDirectory } from "../src/middlewares/document-upload.js";
import { requestIdMiddleware } from "../src/middlewares/request-id.js";
import { departmentRepository } from "../src/repositories/department.repository.js";
import { createDepartmentCache, DEPARTMENT_LIST_CACHE_KEY, departmentCache } from "../src/services/department-cache.service.js";
import { departmentService } from "../src/services/department.service.js";
import { employeeService } from "../src/services/employee.service.js";
import { rateLimitRedisClient } from "../src/config/rate-limit-store.js";
import { sessionService } from "../src/services/session.service.js";
import { sessionLifecycleService } from "../src/services/session-lifecycle.service.js";
import {
    EmployeeScheduledJobsService,
    ENGINEERING_EMPLOYEE_ACTION,
    MISSING_PHONE_ACTION,
} from "../src/services/employee-scheduled-jobs.service.js";


import { createEmployeeCache } from "../src/services/employee-cache.service.js";
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

function sessionIdFrom(account: Account): string {
    const payload = jwt.decode(account.accessToken);
    if (!payload || typeof payload === "string" || typeof payload.sid !== "string") {
        throw new Error("Test login did not return a session claim");
    }
    return payload.sid;
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
        TRUNCATE TABLE session_lifecycle_events, session_daily_summaries,
            employee_documents, audit_logs, refresh_tokens,
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

    // 3. Authentication rejects expired JWTs, incorrect signatures, and unsigned JWTs.
    test("expired, incorrectly signed, and unsigned JWTs are rejected", async () => {
        const account = await login(await createUser());
        const decoded = jwt.decode(account.accessToken) as jwt.JwtPayload;
        const claims = { sub: account.user.id, role: account.user.role, sid: decoded.sid };
        const expired = jwt.sign(claims, config.JWT_SECRET, {
            expiresIn: -1, issuer: "employee-management-api", audience: "employee-management-client",
        });
        const wrongSignature = jwt.sign(claims, "wrong-secret-with-enough-length-123456", {
            issuer: "employee-management-api", audience: "employee-management-client",
        });
        const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, iss: "employee-management-api", aud: "employee-management-client" })).toString("base64url")}.`;

        for (const token of [expired, wrongSignature, unsigned]) {
            const response = await request(app).get(`${api}/auth/sessions`).set(asUser(token));
            expect(response.status).toBe(401);
        }
    });

    test("active session listing returns a paginated result", async () => {
        const user = await createUser();
        const first = await login(user);
        await login(user);
        const response = await request(app).get(`${api}/auth/sessions?page=1&limit=1`).set(asUser(first.accessToken));

        expect(response.status).toBe(200);
        expect(response.body.data.items).toHaveLength(1);
        expect(response.body.data.pagination).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 });
    });

    test("login uses one family ID for JWT sid, PostgreSQL, and Redis", async () => {
        const account = await login(await createUser());
        const sid = (jwt.decode(account.accessToken) as jwt.JwtPayload).sid as string;
        const tokenRows = await AppDataSource.getRepository(RefreshTokenEntity).findBy({ familyId: sid });
        expect(tokenRows).toHaveLength(1);
        expect(tokenRows[0]?.userId).toBe(account.user.id);
        expect(tokenRows[0]?.id).not.toBe(sid);

        const redisValue = await rateLimitRedisClient!.get(`session:${sid}`);
        expect(redisValue).not.toBeNull();
        expect(JSON.parse(redisValue!)).toMatchObject({
            sessionId: sid,
            userId: account.user.id,
            revokedAt: null,
        });
        expect(Date.parse(JSON.parse(redisValue!).expiresAt)).toBeGreaterThan(Date.now());
        expect(await rateLimitRedisClient!.ttl(`session:${sid}`)).toBeGreaterThan(0);

        const tokenHash = createHash("sha256").update(account.refreshToken).digest("hex");
        const metadataKey = `token-meta:refresh:${tokenHash}`;
        const tokenMetadata = await rateLimitRedisClient!.get(metadataKey);
        expect(tokenMetadata).not.toBeNull();
        expect(JSON.parse(tokenMetadata!)).toMatchObject({
            tokenHash,
            userId: account.user.id,
            sessionId: sid,
            revokedAt: null,
        });
        expect(tokenMetadata).not.toContain(account.refreshToken);
        expect(await rateLimitRedisClient!.ttl(metadataKey)).toBeGreaterThan(0);
    });

    test("expired Redis sessions are rejected even when the access JWT has not expired", async () => {
        const account = await login(await createUser());
        const sid = (jwt.decode(account.accessToken) as jwt.JwtPayload).sid as string;
        await sessionService.create(sid, account.user.id, 1);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));

        const response = await request(app).get(`${api}/auth/sessions`).set(asUser(account.accessToken));
        expect(response.status).toBe(401);
        expect(response.body.message).toBe("Account is inactive or session is unavailable");
    });

    test("session API id is the family ID and fetch/revoke target that family", async () => {
        const user = await createUser();
        const first = await login(user);
        const firstSid = (jwt.decode(first.accessToken) as jwt.JwtPayload).sid as string;
        const second = await login(user);
        const secondSid = (jwt.decode(second.accessToken) as jwt.JwtPayload).sid as string;
        expect(firstSid).not.toBe(secondSid);

        const listing = await request(app).get(`${api}/auth/sessions`).set(asUser(first.accessToken));
        expect(listing.status).toBe(200);
        expect(listing.body.data.items.map((item: { id: string }) => item.id).sort()).toEqual([firstSid, secondSid].sort());

        const detail = await request(app).get(`${api}/auth/sessions/${firstSid}`).set(asUser(second.accessToken));
        expect(detail.status).toBe(200);
        expect(detail.body.data.id).toBe(firstSid);

        const revoked = await request(app).delete(`${api}/auth/sessions/${firstSid}`).set(asUser(second.accessToken));
        expect(revoked.status).toBe(200);
        expect(JSON.parse((await rateLimitRedisClient!.get(`session:${firstSid}`))!).revokedAt).toEqual(expect.any(String));
        expect(await rateLimitRedisClient!.get(`session:${secondSid}`)).not.toBeNull();
        expect((await request(app).get(`${api}/auth/sessions`).set(asUser(first.accessToken))).status).toBe(401);
        const firstFamily = await AppDataSource.getRepository(RefreshTokenEntity).findBy({ familyId: firstSid });
        const secondFamily = await AppDataSource.getRepository(RefreshTokenEntity).findBy({ familyId: secondSid });
        expect(firstFamily.every((row) => row.revokedAt !== null)).toBe(true);
        expect(secondFamily.some((row) => row.revokedAt === null)).toBe(true);
    });

    test("refresh rotation retains family ID and a missing Redis session is rejected", async () => {
        const account = await login(await createUser());
        const sid = (jwt.decode(account.accessToken) as jwt.JwtPayload).sid as string;
        const rotated = await request(app).post(`${api}/auth/refresh`).send({ refreshToken: account.refreshToken });
        expect(rotated.status).toBe(200);
        expect((jwt.decode(rotated.body.data.accessToken) as jwt.JwtPayload).sid).toBe(sid);

        await rateLimitRedisClient!.del(`session:${sid}`);
        const response = await request(app).get(`${api}/auth/sessions`).set(asUser(rotated.body.data.accessToken));
        expect(response.status).toBe(401);
        expect(await rateLimitRedisClient!.get(`session:${sid}`)).toBeNull();
    });

    test("Redis unavailability fails closed with a service-unavailable response", async () => {
        const account = await login(await createUser());
        const getSpy = vi.spyOn(rateLimitRedisClient!, "get").mockRejectedValueOnce(new Error("Redis unavailable"));
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const response = await request(app).get(`${api}/auth/sessions`).set(asUser(account.accessToken));
            expect(response.status).toBe(503);
            expect(response.body.code).toBe("SESSION_STORE_UNAVAILABLE");
        } finally {
            getSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    test("Redis cleanup failure does not undo logout or preserve authorization", async () => {
        const account = await login(await createUser());
        const sid = (jwt.decode(account.accessToken) as jwt.JwtPayload).sid as string;
        const evalSpy = vi.spyOn(rateLimitRedisClient!, "eval").mockRejectedValueOnce(new Error("Redis unavailable"));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            const logout = await request(app).post(`${api}/auth/logout`).send({ refreshToken: account.refreshToken });
            expect(logout.status).toBe(200);
            expect(evalSpy).toHaveBeenCalled();
            expect((await AppDataSource.getRepository(RefreshTokenEntity).findBy({ familyId: sid }))
                .every((row) => row.revokedAt !== null)).toBe(true);
            expect((await request(app).get(`${api}/auth/sessions`).set(asUser(account.accessToken))).status).toBe(401);
        } finally {
            evalSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    test("unlinked employee accounts can be paginated", async () => {
        const admin = await adminAccount();
        await createUser();
        await createUser();
        const response = await request(app).get(`${api}/users/unlinked-employees?page=2&limit=1`).set(asUser(admin.accessToken));

        expect(response.status).toBe(200);
        expect(response.body.data.items).toHaveLength(1);
        expect(response.body.data.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
    });

    // 4. Refresh rotation stores a replacement and reuse of the prior token invalidates the family.
    test("refresh rotates tokens and rejects reuse of a previously rotated token", async () => {
        const account = await login(await createUser());
        const rotated = await request(app).post(`${api}/auth/refresh`).send({ refreshToken: account.refreshToken });
        expect(rotated.status).toBe(200);
        expect(rotated.body.data.refreshToken).not.toBe(account.refreshToken);

        const reused = await request(app).post(`${api}/auth/refresh`).send({ refreshToken: account.refreshToken });
        expect(reused.status).toBe(401);
        const sid = (jwt.decode(account.accessToken) as jwt.JwtPayload).sid as string;
        expect(JSON.parse((await rateLimitRedisClient!.get(`session:${sid}`))!).revokedAt).toEqual(expect.any(String));
        const replacementReuse = await request(app).post(`${api}/auth/refresh`).send({
            refreshToken: rotated.body.data.refreshToken,
        });
        expect(replacementReuse.status).toBe(401);
    });

    test("password change revokes refresh families and removes Redis sessions", async () => {
        const account = await login(await createUser());
        const sid = (jwt.decode(account.accessToken) as jwt.JwtPayload).sid as string;
        const response = await request(app).post(`${api}/auth/change-password`)
            .set(asUser(account.accessToken))
            .send({ currentPassword: password, newPassword: "DifferentHorseBatteryStaple456!" });

        expect(response.status).toBe(200);
        expect(JSON.parse((await rateLimitRedisClient!.get(`session:${sid}`))!).revokedAt).toEqual(expect.any(String));
        const rows = await AppDataSource.getRepository(RefreshTokenEntity).findBy({ familyId: sid });
        expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    // 5. Logout revokes one session; logout-all revokes the remaining user's sessions.
    test("logout and logout-all revoke refresh-token sessions", async () => {
        const user = await createUser();
        const first = await login(user);
        const second = await login(user);
        const firstSid = (jwt.decode(first.accessToken) as jwt.JwtPayload).sid as string;
        const secondSid = (jwt.decode(second.accessToken) as jwt.JwtPayload).sid as string;
        expect((await request(app).post(`${api}/auth/logout`).send({ refreshToken: first.refreshToken })).status).toBe(200);
        expect(JSON.parse((await rateLimitRedisClient!.get(`session:${firstSid}`))!).revokedAt).toEqual(expect.any(String));
        const logoutAll = await request(app).post(`${api}/auth/logout-all`).set(asUser(second.accessToken));
        expect(logoutAll.status).toBe(200);
        expect(JSON.parse((await rateLimitRedisClient!.get(`session:${secondSid}`))!).revokedAt).toEqual(expect.any(String));
        expect((await request(app).get(`${api}/auth/sessions`).set(asUser(second.accessToken))).status).toBe(401);
        const active = await AppDataSource.query(
            `SELECT COUNT(*)::int AS count FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
            [user.id],
        ) as Array<{ count: number }>;
        expect(active[0]?.count).toBe(0);
    });

    test("session history is limited to the signed-in user and records lifecycle events", async () => {
        const owner = await login(await createUser());
        await login(await createUser());

        const response = await request(app)
            .get(`${api}/auth/sessions/history`)
            .set(asUser(owner.accessToken));

        expect(response.status).toBe(200);
        expect(response.body.data.items).toHaveLength(1);
        expect(response.body.data.items[0].eventType).toBe("SESSION_CREATED");
        const ownerRows = await AppDataSource.query(
            "SELECT user_id FROM session_lifecycle_events WHERE session_id = $1",
            [sessionIdFrom(owner)],
        ) as Array<{ user_id: string }>;
        expect(ownerRows).toHaveLength(1);
        expect(ownerRows[0]?.user_id).toBe(owner.user.id);
    });

    test("logout and session revocation create idempotent lifecycle audit events", async () => {
        const account = await login(await createUser());
        const sessionId = sessionIdFrom(account);
        const logout = await request(app).post(`${api}/auth/logout`).send({ refreshToken: account.refreshToken });
        expect(logout.status).toBe(200);

        const duplicate = {
            eventKey: `LOGOUT:${sessionId}`,
            userId: account.user.id,
            sessionId,
            eventType: "LOGOUT" as const,
        };
        await sessionLifecycleService.record(duplicate);
        const rows = await AppDataSource.query(
            "SELECT event_type FROM session_lifecycle_events WHERE event_key = $1",
            [`LOGOUT:${sessionId}`],
        ) as Array<{ event_type: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.event_type).toBe("LOGOUT");
    });

    test("only admins with the session metrics permission can view aggregate metrics", async () => {
        const employee = await login(await createUser("employee"));
        const forbidden = await request(app)
            .get(`${api}/admin/session-metrics`)
            .set(asUser(employee.accessToken));
        expect(forbidden.status).toBe(403);

        const admin = await adminAccount();
        const allowed = await request(app)
            .get(`${api}/admin/session-metrics`)
            .set(asUser(admin.accessToken));
        expect(allowed.status).toBe(200);
        expect(allowed.body.data).toHaveProperty("last30Days");
        expect(allowed.body.data).toHaveProperty("dailySummaries");
        expect(allowed.body.data).toHaveProperty("runtime");
    });

    test("expired refresh-token families are recovered by reconciliation and summarized", async () => {
        const account = await login(await createUser());
        const sessionId = sessionIdFrom(account);
        await AppDataSource.query(
            "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE family_id = $1",
            [sessionId],
        );

        await sessionLifecycleService.reconcile();
        const events = await AppDataSource.query(
            "SELECT event_type, processing_status FROM session_lifecycle_events WHERE event_key = $1",
            [`SESSION_EXPIRED:${sessionId}`],
        ) as Array<{ event_type: string; processing_status: string }>;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ event_type: "SESSION_EXPIRED", processing_status: "reconciled" });

        await sessionLifecycleService.generateDailySummary(new Date());
        const summaries = await AppDataSource.query(
            "SELECT expired_sessions FROM session_daily_summaries WHERE summary_date = CURRENT_DATE",
        ) as Array<{ expired_sessions: number }>;
        expect(Number(summaries[0]?.expired_sessions)).toBeGreaterThanOrEqual(1);
    });

    test("Redis expiry stream processing writes one durable audit event", async () => {
        const account = await login(await createUser());
        const sessionId = sessionIdFrom(account);
        await AppDataSource.query(
            "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE family_id = $1",
            [sessionId],
        );

        await sessionLifecycleService.enqueueExpiredSessionEvent(sessionId);
        await sessionLifecycleService.enqueueExpiredSessionEvent(sessionId);
        const events = await AppDataSource.query(
            "SELECT event_type, processing_status FROM session_lifecycle_events WHERE event_key = $1",
            [`SESSION_EXPIRED:${sessionId}`],
        ) as Array<{ event_type: string; processing_status: string }>;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ event_type: "SESSION_EXPIRED", processing_status: "processed" });
    });

    test("token-metadata expiry events resolve by the full hash without logging the hash", async () => {
        const account = await login(await createUser());
        const sessionId = sessionIdFrom(account);
        const refreshRow = await AppDataSource.getRepository(RefreshTokenEntity).findOneBy({ familyId: sessionId });
        expect(refreshRow).not.toBeNull();
        const tokenHash = refreshRow!.tokenHash;
        await AppDataSource.query(
            "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE family_id = $1",
            [sessionId],
        );
        const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

        await sessionLifecycleService.enqueueExpiredTokenMetadataEvent(tokenHash);

        const events = await AppDataSource.query(
            "SELECT event_type FROM session_lifecycle_events WHERE event_key = $1",
            [`SESSION_EXPIRED:${sessionId}`],
        ) as Array<{ event_type: string }>;
        expect(events).toHaveLength(1);
        expect(events[0]?.event_type).toBe("SESSION_EXPIRED");
        expect(JSON.stringify(info.mock.calls)).not.toContain(tokenHash);
    });

    test("Engineering scheduled job logs only Engineering employees once per hourly run", async () => {
        const engineering = await createDepartment("Engineering");
        const operations = await createDepartment("Operations");
        const first = await createEmployee(engineering.id);
        const second = await createEmployee(engineering.id);
        await createEmployee(operations.id);
        const jobs = new EmployeeScheduledJobsService();
        const firstRun = new Date("2026-10-27T10:05:00.000Z");

        await Promise.all([
            jobs.logEngineeringEmployees(firstRun),
            jobs.logEngineeringEmployees(firstRun),
        ]);
        let rows = await AppDataSource.query(
            `SELECT resource_id, action, created_at
             FROM audit_logs WHERE action = $1 ORDER BY resource_id`,
            [ENGINEERING_EMPLOYEE_ACTION],
        ) as Array<{ resource_id: string; action: string; created_at: Date }>;
        expect(rows.map((row) => row.resource_id)).toEqual([first.id, second.id].sort());
        expect(rows.every((row) => row.action === ENGINEERING_EMPLOYEE_ACTION && row.created_at)).toBe(true);

        await jobs.logEngineeringEmployees(new Date("2026-10-27T11:00:00.000Z"));
        const nextHourlyRun = await AppDataSource.query(
            `SELECT resource_id FROM audit_logs WHERE action = $1`,
            [ENGINEERING_EMPLOYEE_ACTION],
        ) as Array<{ resource_id: string }>;
        expect(nextHourlyRun).toHaveLength(4);
    });

    test("missing-phone scheduled job matches null, blank, and whitespace phone values only", async () => {
        const department = await createDepartment("Phone audit");
        const missingValues: Array<string | null> = [null, "", "   ", "\t\n"];
        const matching = await Promise.all(missingValues.map(async (phone) => {
            const employee = await createEmployee(department.id);
            employee.phone = phone;
            return AppDataSource.getRepository(EmployeeEntity).save(employee);
        }));
        const present = await createEmployee(department.id);
        present.phone = "555-0100";
        await AppDataSource.getRepository(EmployeeEntity).save(present);
        const jobs = new EmployeeScheduledJobsService();
        const firstRun = new Date("2026-10-27T10:15:00.000Z");

        await Promise.all([
            jobs.logEmployeesWithMissingPhoneNumbers(firstRun),
            jobs.logEmployeesWithMissingPhoneNumbers(firstRun),
        ]);
        let rows = await AppDataSource.query(
            `SELECT resource_id, action, created_at
             FROM audit_logs WHERE action = $1 ORDER BY resource_id`,
            [MISSING_PHONE_ACTION],
        ) as Array<{ resource_id: string; action: string; created_at: Date }>;
        expect(rows.map((row) => row.resource_id)).toEqual(matching.map((employee) => employee.id).sort());
        expect(rows.every((row) => row.action === MISSING_PHONE_ACTION && row.created_at)).toBe(true);

        await jobs.logEmployeesWithMissingPhoneNumbers(new Date("2026-10-27T10:30:00.000Z"));
        const nextQuarterHourRun = await AppDataSource.query(
            `SELECT resource_id FROM audit_logs WHERE action = $1`,
            [MISSING_PHONE_ACTION],
        ) as Array<{ resource_id: string }>;
        expect(nextQuarterHourRun).toHaveLength(8);
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

    // 16. This isolated app instance uses a private in-memory limiter for deterministic testing.
    test("repeated authentication requests trigger rate limiting", async () => {
        const previousLimit = process.env.AUTH_RATE_LIMIT_MAX_REQUESTS;
        const previousRedisUrl = process.env.REDIS_URL;
        process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = "1";
        process.env.REDIS_URL = "";
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
            if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
            else process.env.REDIS_URL = previousRedisUrl;
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
            { sub: randomUUID(), role: "admin", sid: randomUUID() },
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

    test("employee document listing is paginated", async () => {
        const department = await createDepartment();
        const employeeUser = await createUser();
        const employee = await createEmployee(department.id, { user: employeeUser });
        const account = await login(employeeUser);
        const repository = AppDataSource.getRepository(EmployeeDocumentEntity);
        for (let index = 0; index < 3; index += 1) {
            await repository.save(repository.create({
                employeeId: employee.id,
                uploadedByUserId: employeeUser.id,
                originalFilename: `document-${index}.pdf`,
                storageFilename: `${randomUUID()}.pdf`,
                mimeType: "application/pdf",
                sizeBytes: 100,
            }));
        }

        const response = await request(app)
            .get(`${api}/employees/${employee.id}/documents?page=2&limit=2`)
            .set(asUser(account.accessToken));
        expect(response.status).toBe(200);
        expect(response.body.data.items).toHaveLength(1);
        expect(response.body.data.pagination).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    test("download-link audit records the request ID", async () => {
        const department = await createDepartment();
        const employeeUser = await createUser();
        const employee = await createEmployee(department.id, { user: employeeUser });
        const account = await login(employeeUser);
        const document = await AppDataSource.getRepository(EmployeeDocumentEntity).save(
            AppDataSource.getRepository(EmployeeDocumentEntity).create({
                employeeId: employee.id,
                uploadedByUserId: employeeUser.id,
                originalFilename: "audit-test.pdf",
                storageFilename: `${randomUUID()}.pdf`,
                mimeType: "application/pdf",
                sizeBytes: 100,
            }),
        );

        const response = await request(app)
            .get(`${api}/documents/${document.id}/download-url`)
            .set(asUser(account.accessToken));
        expect(response.status).toBe(200);
        const rows = await AppDataSource.query(
            "SELECT request_id FROM audit_logs WHERE action = $1 AND resource_id = $2",
            ["employee_document.download_link_created", document.id],
        ) as Array<{ request_id: string }>;
        expect(rows[0]?.request_id).toBe(response.body.requestId);
    });
});

describe("department-list Redis cache", () => {
    beforeEach(async () => {
        await departmentCache.invalidate();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("returns the cached response for the exact default query without querying PostgreSQL", async () => {
        const cached = {
            items: [{
                id: randomUUID(),
                name: "Cached department",
                description: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            }],
            pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
        };
        const cacheRead = vi.spyOn(departmentCache, "getDefault").mockResolvedValue(cached);
        const query = vi.spyOn(departmentRepository, "createQueryBuilder");

        const result = await departmentService.getAllDepartments();

        expect(result).toEqual(cached);
        expect(cacheRead).toHaveBeenCalledOnce();
        expect(query).not.toHaveBeenCalled();
    });

    test("fills the cache on a default-query miss and preserves the paginated response", async () => {
        await createDepartment("Cache miss department");
        vi.spyOn(departmentCache, "getDefault").mockResolvedValue(undefined);
        const cacheWrite = vi.spyOn(departmentCache, "setDefault").mockResolvedValue();

        const result = await departmentService.getAllDepartments();

        expect(result.items).toHaveLength(1);
        expect(result.pagination).toEqual({ page: 1, limit: 10, total: 1, totalPages: 1 });
        expect(cacheWrite).toHaveBeenCalledWith(result);
    });

    test("uses Redis for department detail hits and fills Redis after a PostgreSQL miss", async () => {
        const department = await createDepartment("Department detail cache");
        const cacheRead = vi.spyOn(departmentCache, "getDepartment")
            .mockResolvedValueOnce(department)
            .mockResolvedValueOnce(undefined);
        const dbRead = vi.spyOn(departmentRepository, "findOneBy");
        const cacheWrite = vi.spyOn(departmentCache, "setDepartment").mockResolvedValue();

        const cached = await departmentService.getDepartmentById(department.id);
        expect(cached).toEqual(department);
        expect(dbRead).not.toHaveBeenCalled();

        const fromDatabase = await departmentService.getDepartmentById(department.id);
        expect(fromDatabase?.id).toBe(department.id);
        expect(dbRead).toHaveBeenCalledOnce();
        expect(cacheWrite).toHaveBeenCalledWith(fromDatabase);
        expect(cacheRead).toHaveBeenCalledTimes(2);
    });

    test("department detail falls back to PostgreSQL and caches with a five-minute TTL if Redis fails", async () => {
        const department = await createDepartment("Department Redis fallback");
        const redis = {
            get: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
            set: vi.fn().mockResolvedValue("OK"),
            del: vi.fn().mockResolvedValue(1),
        } as unknown as NonNullable<typeof rateLimitRedisClient>;
        const cache = createDepartmentCache(redis, vi.fn().mockResolvedValue(undefined));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(departmentCache, "getDepartment").mockImplementation((id) => cache.getDepartment(id));
        vi.spyOn(departmentCache, "setDepartment").mockImplementation((value) => cache.setDepartment(value));

        const result = await departmentService.getDepartmentById(department.id);

        expect(result?.id).toBe(department.id);
        expect(redis.get).toHaveBeenCalledWith(`department:${department.id}`);
        expect(redis.set).toHaveBeenCalledWith(
            `department:${department.id}`,
            JSON.stringify(result),
            { EX: 300 },
        );
    });

    test("search, non-default pagination, and custom sorting bypass the default cache", async () => {
        await createDepartment("Engineering");
        await createDepartment("Human Resources");
        const cacheRead = vi.spyOn(departmentCache, "getDefault");
        const cacheWrite = vi.spyOn(departmentCache, "setDefault");

        const searched = await departmentService.getAllDepartments({
            page: 1, limit: 10, sortBy: "createdAt", sortOrder: "desc", search: "Engineering",
        });
        const paged = await departmentService.getAllDepartments({
            page: 2, limit: 10, sortBy: "createdAt", sortOrder: "desc",
        });
        const sorted = await departmentService.getAllDepartments({
            page: 1, limit: 10, sortBy: "name", sortOrder: "asc",
        });

        expect(searched.items).toHaveLength(1);
        expect(paged.pagination.page).toBe(2);
        expect(sorted.items.map((item) => item.name)).toEqual(["Engineering", "Human Resources"]);
        expect(cacheRead).not.toHaveBeenCalled();
        expect(cacheWrite).not.toHaveBeenCalled();
    });

    test("invalidates after department creation has committed", async () => {
        let visibleAfterCommit = false;
        const invalidation = vi.spyOn(departmentCache, "invalidate").mockImplementation(async () => {
            visibleAfterCommit = Boolean(await departmentRepository.findOneBy({ name: "Created after commit" }));
        });

        const created = await departmentService.createDepartment({ name: "Created after commit" });

        expect(created.name).toBe("Created after commit");
        expect(invalidation).toHaveBeenCalledOnce();
        expect(visibleAfterCommit).toBe(true);
    });

    test("invalidates after department update has committed", async () => {
        const department = await createDepartment("Before update");
        const detailInvalidation = vi.spyOn(departmentCache, "invalidateDepartment").mockResolvedValue();
        let updatedValueVisible = false;
        const invalidation = vi.spyOn(departmentCache, "invalidate").mockImplementation(async () => {
            const committed = await departmentRepository.findOneBy({ id: department.id });
            updatedValueVisible = committed?.name === "After update";
        });

        const updated = await departmentService.updateDepartment(department.id, { name: "After update" });

        expect(updated?.name).toBe("After update");
        expect(invalidation).toHaveBeenCalledOnce();
        expect(detailInvalidation).toHaveBeenCalledWith(department.id);
        expect(updatedValueVisible).toBe(true);
    });

    test("invalidates after department deletion has committed", async () => {
        const department = await createDepartment("Delete after commit");
        const detailInvalidation = vi.spyOn(departmentCache, "invalidateDepartment").mockResolvedValue();
        let rowIsGoneAfterCommit = false;
        const invalidation = vi.spyOn(departmentCache, "invalidate").mockImplementation(async () => {
            rowIsGoneAfterCommit = !(await departmentRepository.findOneBy({ id: department.id }));
        });

        const deleted = await departmentService.deleteDepartment(department.id);

        expect(deleted).toBe(true);
        expect(invalidation).toHaveBeenCalledOnce();
        expect(detailInvalidation).toHaveBeenCalledWith(department.id);
        expect(rowIsGoneAfterCommit).toBe(true);
    });

    test("does not invalidate for a nonexistent department update or deletion", async () => {
        const invalidation = vi.spyOn(departmentCache, "invalidate");
        const detailInvalidation = vi.spyOn(departmentCache, "invalidateDepartment");
        const missingId = randomUUID();

        expect(await departmentService.updateDepartment(missingId, { name: "No department" })).toBeNull();
        expect(await departmentService.deleteDepartment(missingId)).toBe(false);
        expect(invalidation).not.toHaveBeenCalled();
        expect(detailInvalidation).not.toHaveBeenCalled();
    });

    test("falls back to PostgreSQL when Redis is unavailable", async () => {
        await createDepartment("Redis unavailable fallback");
        const failingRedis = {
            get: vi.fn().mockRejectedValue(new Error("Redis unavailable")),
            set: vi.fn(),
            del: vi.fn(),
        } as unknown as NonNullable<typeof rateLimitRedisClient>;
        const cache = createDepartmentCache(failingRedis, vi.fn().mockResolvedValue(undefined));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(departmentCache, "getDefault").mockImplementation(() => cache.getDefault());
        vi.spyOn(departmentCache, "setDefault").mockResolvedValue();

        const result = await departmentService.getAllDepartments();

        expect(result.items.map((item) => item.name)).toContain("Redis unavailable fallback");
        expect(failingRedis.get).toHaveBeenCalledWith(DEPARTMENT_LIST_CACHE_KEY);
    });

    test("malformed cached JSON is deleted and treated as a cache miss", async () => {
        await createDepartment("Malformed cache fallback");
        const malformedRedis = {
            get: vi.fn().mockResolvedValue("{not-json"),
            set: vi.fn(),
            del: vi.fn().mockResolvedValue(1),
        } as unknown as NonNullable<typeof rateLimitRedisClient>;
        const cache = createDepartmentCache(malformedRedis, vi.fn().mockResolvedValue(undefined));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(departmentCache, "getDefault").mockImplementation(() => cache.getDefault());
        vi.spyOn(departmentCache, "setDefault").mockResolvedValue(undefined);

        const result = await departmentService.getAllDepartments();

        expect(result.items.map((item) => item.name)).toContain("Malformed cache fallback");
        expect(malformedRedis.del).toHaveBeenCalledWith(DEPARTMENT_LIST_CACHE_KEY);
    });

        test("writes the default cache key without a TTL", async () => {
                    const redis = {
                        get: vi.fn(),
                        set: vi.fn().mockResolvedValue("OK"),
                        del: vi.fn(),
                    } as unknown as NonNullable<typeof rateLimitRedisClient>;

                    const cache = createDepartmentCache(
                        redis,
                        vi.fn().mockResolvedValue(undefined),
                    );

                    const value = {
                        items: [],
                        pagination: {
                            page: 1,
                            limit: 10,
                            total: 0,
                            totalPages: 0,
                        },
                    };

                    await cache.setDefault(value);

                    expect(redis.set).toHaveBeenCalledWith(
                        DEPARTMENT_LIST_CACHE_KEY,
                        JSON.stringify(value),
                    );
                    expect(redis.set).toHaveBeenCalledTimes(1);
        });

    test("Redis invalidation failure does not report a committed department creation as failed", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(departmentCache, "invalidate").mockRejectedValue(new Error("Redis unavailable"));

        const created = await departmentService.createDepartment({ name: "Created despite Redis failure" });

        expect(created.name).toBe("Created despite Redis failure");
        expect(await departmentRepository.findOneBy({ id: created.id })).not.toBeNull();
    });
});



describe("employee Redis cache", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function createMockRedis() {
        return {
            get: vi.fn(),
            set: vi.fn().mockResolvedValue("OK"),
            del: vi.fn().mockResolvedValue(1),
            scan: vi.fn().mockResolvedValue({
                cursor: "0",
                keys: [],
            }),
        } as unknown as NonNullable<typeof rateLimitRedisClient>;
    }

    function createCache(
        redis: NonNullable<typeof rateLimitRedisClient>,
        ttls?: { detailSeconds: number; listSeconds: number },
    ) {
        return createEmployeeCache(
            redis,
            vi.fn().mockResolvedValue(undefined),
            ttls,
        );
    }

    test("an expired employee cache entry is treated as a miss", async () => {
        vi.useFakeTimers();
        const values = new Map<string, { value: string; expiresAt: number }>();
        const redis = {
            get: vi.fn(async (key: string) => {
                const entry = values.get(key);
                if (!entry || entry.expiresAt <= Date.now()) {
                    values.delete(key);
                    return null;
                }
                return entry.value;
            }),
            set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
                values.set(key, {
                    value,
                    expiresAt: Date.now() + (options?.EX ?? 0) * 1000,
                });
                return "OK";
            }),
            del: vi.fn().mockResolvedValue(1),
            scan: vi.fn().mockResolvedValue({ cursor: "0", keys: [] }),
        } as unknown as NonNullable<typeof rateLimitRedisClient>;
        const cache = createCache(redis, { detailSeconds: 1, listSeconds: 1 });
        const id = randomUUID();
        const employee = { id, firstName: "Temporary", lastName: "Cache" };

        try {
            await cache.setDetail(id, employee);
            expect(await cache.getDetail(id)).toEqual(employee);

            await vi.advanceTimersByTimeAsync(1_001);
            expect(await cache.getDetail(id)).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    test("writes employee detail with a 5-minute TTL", async () => {
        const redis = createMockRedis();
        const cache = createCache(redis);

        const id = randomUUID();
        const employee = {
            id,
            firstName: "Test",
            lastName: "Employee",
        };

        await cache.setDetail(id, employee);

        expect(redis.set).toHaveBeenCalledWith(
            `employees:detail:${id}`,
            JSON.stringify(employee),
            { EX: 300 },
        );
    });

    test("writes employee list with a 1-minute TTL", async () => {
        const redis = createMockRedis();
        const cache = createCache(redis);

        const filters = {
            page: 1,
            limit: 10,
            role: "hr",
        };

        const result = {
            items: [],
            pagination: {
                page: 1,
                limit: 10,
                total: 0,
                totalPages: 0,
            },
        };

        await cache.setList(filters, result);

        expect(redis.set).toHaveBeenCalledWith(
            expect.stringMatching(/^employees:list:[a-f0-9]{64}$/),
            JSON.stringify(result),
            { EX: 60 },
        );
    });

    test("returns cached employee detail", async () => {
        const id = randomUUID();

        const employee = {
            id,
            firstName: "Cached",
            lastName: "Employee",
        };

        const redis = createMockRedis();

        vi.mocked(redis.get).mockResolvedValue(
            JSON.stringify(employee),
        );

        const cache = createCache(redis);

        const result = await cache.getDetail<typeof employee>(id);

        expect(result).toEqual(employee);
        expect(redis.get).toHaveBeenCalledWith(
            `employees:detail:${id}`,
        );
    });

    test("returns a cache miss when employee detail does not exist", async () => {
        const redis = createMockRedis();

        vi.mocked(redis.get).mockResolvedValue(null);

        const cache = createCache(redis);

        const result = await cache.getDetail(randomUUID());

        expect(result).toBeUndefined();
    });

    test("returns cached employee list", async () => {
        const filters = {
            page: 1,
            limit: 10,
        };

        const resultData = {
            items: [],
            pagination: {
                page: 1,
                limit: 10,
                total: 0,
                totalPages: 0,
            },
        };

        const redis = createMockRedis();

        vi.mocked(redis.get).mockResolvedValue(
            JSON.stringify(resultData),
        );

        const cache = createCache(redis);

        const result = await cache.getList<typeof resultData>(filters);

        expect(result).toEqual(resultData);
        expect(redis.get).toHaveBeenCalledWith(
            expect.stringMatching(/^employees:list:[a-f0-9]{64}$/),
        );
    });

    test("uses different cache keys for different employee filters", async () => {
        const redis = createMockRedis();
        const cache = createCache(redis);

        await cache.setList(
            { page: 1, limit: 10 },
            { items: ["first"] },
        );

        await cache.setList(
            { page: 2, limit: 10 },
            { items: ["second"] },
        );

        const firstKey = vi.mocked(redis.set).mock.calls[0]?.[0];
        const secondKey = vi.mocked(redis.set).mock.calls[1]?.[0];

        expect(firstKey).not.toBe(secondKey);
    });

    test("deletes malformed employee detail cache", async () => {
        const id = randomUUID();
        const redis = createMockRedis();

        vi.mocked(redis.get).mockResolvedValue("{invalid-json");

        const cache = createCache(redis);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const result = await cache.getDetail(id);

        expect(result).toBeUndefined();
        expect(redis.del).toHaveBeenCalledWith([
            `employees:detail:${id}`,
        ]);
    });

    test("falls back safely when Redis reads fail", async () => {
        const redis = createMockRedis();

        vi.mocked(redis.get).mockRejectedValue(
            new Error("Redis unavailable"),
        );

        const cache = createCache(redis);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(
            cache.getDetail(randomUUID()),
        ).resolves.toBeUndefined();

        await expect(
            cache.getList({ page: 1 }),
        ).resolves.toBeUndefined();
    });

    test("does not throw when writing employee cache fails", async () => {
        const redis = createMockRedis();

        vi.mocked(redis.set).mockRejectedValue(
            new Error("Redis unavailable"),
        );

        const cache = createCache(redis);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(
            cache.setDetail(randomUUID(), {
                firstName: "Test",
            }),
        ).resolves.toBeUndefined();
    });

    test("invalidates employee detail and list keys", async () => {
        const redis = createMockRedis();

        vi.mocked(redis.scan).mockResolvedValueOnce({
            cursor: "0",
            keys: [
                "employees:detail:123",
                "employees:list:abc",
            ],
        });

        const cache = createCache(redis);

        await cache.invalidateAll();

        expect(redis.scan).toHaveBeenCalledWith("0", {
            MATCH: "employees:*",
            COUNT: 100,
        });

        expect(redis.del).toHaveBeenCalledWith([
            "employees:detail:123",
            "employees:list:abc",
        ]);
    });

    test("continues scanning when Redis returns multiple batches", async () => {
        const redis = createMockRedis();

        vi.mocked(redis.scan)
            .mockResolvedValueOnce({
                cursor: "25",
                keys: ["employees:detail:1"],
            })
            .mockResolvedValueOnce({
                cursor: "0",
                keys: ["employees:list:abc"],
            });

        const cache = createCache(redis);

        await cache.invalidateAll();

        expect(redis.scan).toHaveBeenCalledTimes(2);

        expect(redis.scan).toHaveBeenNthCalledWith(1, "0", {
            MATCH: "employees:*",
            COUNT: 100,
        });

        expect(redis.scan).toHaveBeenNthCalledWith(2, "25", {
            MATCH: "employees:*",
            COUNT: 100,
        });

        expect(redis.del).toHaveBeenCalledWith([
            "employees:detail:1",
        ]);

        expect(redis.del).toHaveBeenCalledWith([
            "employees:list:abc",
        ]);
    });

    test("does not throw if cache invalidation fails", async () => {
        const redis = createMockRedis();

        vi.mocked(redis.scan).mockRejectedValue(
            new Error("Redis unavailable"),
        );

        const cache = createCache(redis);

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(
            cache.invalidateAll(),
        ).resolves.toBeUndefined();
    });
});
