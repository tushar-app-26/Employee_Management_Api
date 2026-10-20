import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { employeeListQuerySchema, createEmployeeSchema } from "../src/validators/employee.validator.ts";
import { registerSchema } from "../src/validators/auth.validator.ts";
import { departmentListQuerySchema } from "../src/validators/department.validator.ts";
import { validateRequest } from "../src/middlewares/validate-request.ts";
import { employeeRepository } from "../src/repositories/employee.repository.ts";
import { departmentRepository } from "../src/repositories/department.repository.ts";
import { employeeService } from "../src/services/employee.service.ts";
import { departmentService } from "../src/services/department.service.ts";

const originalEmployeeQueryBuilder = employeeRepository.createQueryBuilder;
const originalDepartmentQueryBuilder = departmentRepository.createQueryBuilder;

afterEach(() => {
    employeeRepository.createQueryBuilder = originalEmployeeQueryBuilder;
    departmentRepository.createQueryBuilder = originalDepartmentQueryBuilder;
});

function createQueryBuilderStub(result) {
    const calls = { where: [], order: null, offset: null, limit: null };
    const builder = {
        leftJoinAndSelect() {
            return builder;
        },
        addSelect() {
            return builder;
        },
        andWhere(sql, parameters) {
            calls.where.push({ sql, parameters });
            return builder;
        },
        orderBy(field, direction) {
            calls.order = { field, direction };
            return builder;
        },
        skip(offset) {
            calls.offset = offset;
            return builder;
        },
        take(limit) {
            calls.limit = limit;
            return builder;
        },
        async getManyAndCount() {
            return result;
        },
    };
    return { builder, calls };
}

function runQueryValidation(schema, query) {
    const req = { query };
    const res = {
        locals: { requestId: "test-request" },
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
    let nextCalled = false;
    validateRequest(schema, "query")(req, res, () => {
        nextCalled = true;
    });
    return { req, res, nextCalled };
}

test("employee query validates pagination and allowlisted sorting", () => {
    assert.equal(employeeListQuerySchema.safeParse({ page: "0" }).success, false);
    assert.equal(employeeListQuerySchema.safeParse({ limit: "101" }).success, false);
    assert.equal(employeeListQuerySchema.safeParse({ sortBy: "firstName; DROP TABLE employees" }).success, false);
    assert.equal(employeeListQuerySchema.safeParse({ sortOrder: "sideways" }).success, false);
    assert.equal(createEmployeeSchema.safeParse({
        workEmail: "person@company.test",
        departmentId: "e56b6c5c-f56e-4170-86fc-b795311afa45",
        jobTitle: "Engineer",
        joiningDate: "2025-01-15",
    }).success, false);

    const defaults = employeeListQuerySchema.parse({});
    assert.deepEqual(defaults, {
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
    });
});

test("registration requires a name and cannot self-assign a role", () => {
    assert.equal(registerSchema.safeParse({
        email: "new@example.test",
        password: "password123",
    }).success, false);
    assert.equal(registerSchema.safeParse({
        firstName: "New",
        lastName: "User",
        email: "new@example.test",
        password: "password123",
        role: "hr",
    }).success, false);
    assert.equal(registerSchema.safeParse({
        firstName: "New",
        lastName: "User",
        email: "new@example.test",
        password: "password123",
    }).success, true);
});

test("department query rejects invalid pagination, sort, and unknown fields", () => {
    assert.equal(departmentListQuerySchema.safeParse({ page: "-1" }).success, false);
    assert.equal(departmentListQuerySchema.safeParse({ limit: "101" }).success, false);
    assert.equal(departmentListQuerySchema.safeParse({ sortBy: "password" }).success, false);
    assert.equal(departmentListQuerySchema.safeParse({ unexpected: "value" }).success, false);
});

test("query middleware returns 400 for invalid runtime query parameters", () => {
    const { res, nextCalled } = runQueryValidation(employeeListQuerySchema, {
        page: "1",
        limit: "101",
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(nextCalled, false);
});

test("query middleware stores parsed defaults for the controller", () => {
    const { res, nextCalled } = runQueryValidation(departmentListQuerySchema, {
        page: "2",
        limit: "5",
    });

    assert.equal(nextCalled, true);
    assert.deepEqual(res.locals.validatedQuery, {
        page: 2,
        limit: 5,
        sortBy: "createdAt",
        sortOrder: "desc",
    });
});

test("employee listing returns empty results with pagination metadata", async () => {
    const stub = createQueryBuilderStub([[], 0]);
    employeeRepository.createQueryBuilder = () => stub.builder;

    const result = await employeeService.getAllEmployees(
        employeeListQuerySchema.parse({ page: "3", limit: "5" }),
    );

    assert.deepEqual(result.items, []);
    assert.deepEqual(result.pagination, {
        page: 3,
        limit: 5,
        total: 0,
        totalPages: 0,
    });
    assert.equal(stub.calls.offset, 10);
    assert.equal(stub.calls.limit, 5);
});

test("employee listing applies combined parameterized filters and allowlisted sort", async () => {
    const stub = createQueryBuilderStub([[{ id: "employee-1" }], 1]);
    employeeRepository.createQueryBuilder = () => stub.builder;
    const options = employeeListQuerySchema.parse({
        page: "2",
        limit: "25",
        search: "  Asha  ",
        departmentId: "e56b6c5c-f56e-4170-86fc-b795311afa45",
        employmentStatus: "active",
        sortBy: "lastName",
        sortOrder: "asc",
    });

    const result = await employeeService.getAllEmployees(options);

    assert.equal(result.items.length, 1);
    assert.equal(result.pagination.totalPages, 1);
    assert.equal(stub.calls.where.length, 3);
    assert.match(stub.calls.where[0].sql, /:search/);
    assert.deepEqual(stub.calls.where[0].parameters, { search: "%Asha%" });
    assert.deepEqual(stub.calls.where[1].parameters, {
        departmentId: "e56b6c5c-f56e-4170-86fc-b795311afa45",
    });
    assert.deepEqual(stub.calls.where[2].parameters, { status: "active" });
    assert.deepEqual(stub.calls.order, {
        field: "employee_sort_last_name",
        direction: "ASC",
    });
    assert.equal(stub.calls.offset, 25);
});

test("department listing returns empty results with pagination metadata", async () => {
    const stub = createQueryBuilderStub([[], 0]);
    departmentRepository.createQueryBuilder = () => stub.builder;

    const result = await departmentService.getAllDepartments(
        departmentListQuerySchema.parse({ page: "4", limit: "7" }),
    );

    assert.deepEqual(result.items, []);
    assert.deepEqual(result.pagination, {
        page: 4,
        limit: 7,
        total: 0,
        totalPages: 0,
    });
    assert.equal(stub.calls.offset, 21);
    assert.equal(stub.calls.limit, 7);
});

test("department listing applies parameterized search with pagination and sorting", async () => {
    const stub = createQueryBuilderStub([[{ id: "department-1" }], 1]);
    departmentRepository.createQueryBuilder = () => stub.builder;
    const options = departmentListQuerySchema.parse({
        page: "2",
        limit: "5",
        search: "  finance ",
        sortBy: "name",
        sortOrder: "asc",
    });

    const result = await departmentService.getAllDepartments(options);

    assert.equal(result.items.length, 1);
    assert.equal(stub.calls.where.length, 1);
    assert.match(stub.calls.where[0].sql, /:search/);
    assert.deepEqual(stub.calls.where[0].parameters, { search: "%finance%" });
    assert.deepEqual(stub.calls.order, {
        field: "department.name",
        direction: "ASC",
    });
    assert.equal(stub.calls.offset, 5);
});
