# Employee Management API

A versioned REST API for managing employees and departments. It is built with Node.js, Express 5, TypeScript, PostgreSQL, TypeORM, and Zod.

## Requirements

- Node.js and npm
- PostgreSQL
- A private S3 bucket for the default document-storage configuration
- Redis for shared production rate limits (optional in local development)
- A database with the required project schema/migrations applied

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set your PostgreSQL connection string, private JWT secret of at least 32 characters, AWS region and private S3 bucket. Set AWS access keys or use the AWS SDK's workload credentials. Do not commit `.env` or share its values. Set `REDIS_URL` when using Redis locally; production requires it.

3. Create an empty PostgreSQL database. TypeORM schema synchronization and automatic migration execution are disabled (`synchronize: false`, `migrationsRun: false`). Apply the TypeORM migrations:

   ```bash
   npm run migration:show
   npm run migration:run
   ```

   The first migration creates `departments` and `employees`; subsequent migrations create/update the remaining schema. The base migration safely adopts a database where both tables already exist. Never use schema synchronization to replace migrations.

4. Start the development server:

   ```bash
   npm run dev
   ```

   The default port is `3000`. Check `GET /health` to confirm the server is responding.

## Commands

- `npm run dev` — run the TypeScript server with watch mode.
- `npm run typecheck` — check TypeScript types without emitting files.
- `npm run build` — compile TypeScript into `dist/`.
- `npm start` — start the compiled server.
- `npm run migration:show` — show TypeORM migration status.
- `npm run migration:run` — apply pending TypeORM migrations.
- `npm run migration:revert` — revert the latest TypeORM migration; use only after reviewing its impact.
- `npm run seed:dev-departments` — create sample departments in development only.
- `npm run seed:dev-hr` — create a development-only HR account.
- `npm run seed:dev-admin` — create a development-only administrator account.
- `npm run retention:report` — count inactive employee records past the review interval; does not delete employee data.
- `npm run audit:prune` — delete audit records older than `AUDIT_LOG_RETENTION_DAYS`; run only under the approved retention policy.

## Employee scheduled jobs

The server starts two `node-cron` jobs after PostgreSQL initializes: `0 * * * *` logs Engineering employees once per hour, and `*/15 * * * *` logs employees with missing phone numbers every 15 minutes. Both schedules use UTC. Entries are written to `audit_logs` with the employee UUID as `resource_id`; a database uniqueness index prevents duplicate entries for the same employee and scheduled run while allowing later runs to log them again. Apply migrations with `npm run migration:run` before deploying the jobs.

To verify the latest entries, query `audit_logs` for the actions `Engineering employee detected` and `Employee phone number missing`. The associated `created_at` column is populated by PostgreSQL.

## Architecture and resilience documentation

- [High-level and low-level design](docs/hld-lld.md) includes the component diagram, module contracts, ERD, and API error types.
- [LAB 6 resilience and storage recovery](docs/lab6-resilience-and-storage.md) describes timeouts, retry behavior, storage recovery, and operational checks.

## Employee documents (private object storage)

Documents use the S3 adapter by default (`DOCUMENT_STORAGE_DRIVER=s3`). Configure `AWS_REGION`, `AWS_S3_BUCKET`, and either `AWS_ACCESS_KEY_ID` plus `AWS_SECRET_ACCESS_KEY` or an AWS workload credential provider. Keep bucket public access blocked. `S3_REQUEST_TIMEOUT_MS` bounds network requests and `S3_PRESIGNED_URL_TTL_SECONDS` controls short-lived downloads. The IAM identity needs only object-level upload, read, and delete permissions for the configured bucket.


The API accepts one PDF, PNG, or JPEG file up to `DOCUMENT_MAX_SIZE_MB` (default 5 MB) in the `document` multipart field. It checks the extension, declared MIME type, and file signature, then creates a server-generated object key. Only metadata is stored in PostgreSQL. Set Postman's `documentFile` variable to a local test-file path, upload against an employee ID the caller may access, request a short-lived download URL, and use the collection's download request. HR/admin can delete documents; uploaders and employees can list/download only within their permitted employee scope. Upload, download-link creation, and deletion are audited.

Set `DOCUMENT_STORAGE_DRIVER=local` only for development/test environments that need the private `DOCUMENT_STORAGE_DIR` adapter. It is not shared or durable across multiple application servers. Integration tests explicitly choose local storage and use a dedicated test database.

Apply the new metadata table with `npm run migration:run` before calling document routes. No file is served from a static/public directory.

## Shared rate limits

The API uses Redis-backed stores with separate prefixes for authentication and general API requests when `REDIS_URL` is configured. Production startup requires Redis so replicas share counters. Local development and tests may leave `REDIS_URL` empty and use the default in-process store.

## API conventions

All application routes are under `/api/v1`. Responses use this envelope:

```json
{
  "statusCode": 200,
  "success": true,
  "message": "Employees fetched successfully",
  "data": {},
  "timestamp": "2026-01-01T00:00:00.000Z",
  "requestId": "request-id"
}
```

For protected employee endpoints, send `Authorization: Bearer <accessToken>`. Request bodies are JSON. Validation errors and application errors use the same response envelope.

## Endpoints

### Authentication

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/register` | Create a login account with first/last name, email, and password; role is assigned as `employee`. |
| POST | `/api/v1/auth/login` | Verify credentials and return an access token and refresh token. |
| POST | `/api/v1/auth/refresh` | Exchange a valid refresh token for a new access/refresh token pair. The submitted token is revoked as part of the exchange. |
| POST | `/api/v1/auth/logout` | Revoke the refresh-token session supplied in the request body. |
| POST | `/api/v1/auth/logout-all` | Revoke all refresh sessions for the logged-in user. |
| GET | `/api/v1/auth/sessions` | List the logged-in user’s active sessions. |
| DELETE | `/api/v1/auth/sessions/:id` | Revoke one session belonging to the logged-in user. |
| POST | `/api/v1/auth/change-password` | Verify current password, set a new password, and revoke refresh sessions. |

Refresh/logout body:

```json
{ "refreshToken": "<refresh-token-from-login>" }
```

Access tokens default to 15 minutes (`JWT_ACCESS_TTL`, maximum one hour) and are bound to a refresh-token session family. Refresh tokens default to 7 days (`REFRESH_TOKEN_TTL_DAYS`) and are stored in the database as SHA-256 hashes, not plaintext. Refresh rotations retain a session family ID; reusing a rotated/revoked token revokes the remaining tokens in that family. Password changes, role changes, account deactivation, and explicit logout revoke refresh sessions and invalidate access tokens on the next request. Protected requests check the current account status and role in PostgreSQL.

Refresh tokens are returned in the login response and submitted in the JSON body to refresh/logout endpoints. This bearer-token design requires clients to keep refresh tokens in protected platform storage; do not put them in URLs, logs, or browser local storage. A browser client should use a carefully designed HttpOnly cookie plus CSRF protections instead.

### Employees

All employee endpoints require a valid access token.

| Method | Path | Allowed roles | Purpose |
|---|---|---|---|
| GET | `/api/v1/employees` | admin, hr, manager | List employees; managers see direct reports only. Supports pagination, search/filtering, and sorting. |
| GET | `/api/v1/employees/me` | all authenticated roles | Fetch the caller's linked employee profile. |
| PATCH | `/api/v1/employees/me` | all authenticated roles | Update own first name, last name, and phone only. |
| GET | `/api/v1/employees/me/export` | all authenticated roles | Export own account and employment profile as JSON. |
| GET | `/api/v1/employees/:id` | admin, hr, assigned manager | Fetch a profile; managers can access direct reports only. |
| GET | `/api/v1/users/unlinked-employees` | admin, hr | List registered employee-role accounts that do not yet have an employment profile. |
| POST | `/api/v1/employees` | admin, hr | Link a registered user account to an employment profile. |
| PATCH | `/api/v1/employees/:id` | admin, hr, assigned manager | Admin/HR can update approved employment fields; managers can change direct-report phone/job title only. |
| DELETE | `/api/v1/employees/:id` | admin | Deactivate the employee, linked account, and refresh sessions; retain the employee data. |
| PATCH | `/api/v1/users/:id/access` | admin | Assign an allowed role or activate/deactivate an account. Role/status changes are audited and revoke refresh sessions. An account linked to an inactive/terminated employee cannot be reactivated until HR/admin restores that profile. |
| DELETE | `/api/v1/users/:id/sessions` | admin | Revoke every active session, invalidating that account's refresh and access tokens. |

Supported employment statuses are `active`, `inactive`, `on_leave`, and `terminated`. Employee list pagination defaults to page 1 and 10 items; `limit` must be between 1 and 100.

The account and job profile are separate. A person first registers a login account; HR then links that account to an employment profile. Password hashes stay only in `users`; employee profiles do not store passwords. For linked employees, the name is stored in both `users` and `employees` and the API keeps the two values synchronized, so it is visible directly in either table.

Registration body:

```json
{
  "firstName": "Asha",
  "lastName": "Kumar",
  "email": "asha@example.com",
  "password": "AtLeast8Characters"
}
```

Registration always assigns role `employee`; clients must not send `role` or `employeeId`. After logging in as HR/admin, call `GET /api/v1/users/unlinked-employees`, choose the registered account `id`, then create its job profile:

```json
{
  "userId": "11111111-1111-4111-8111-111111111111",
  "workEmail": "asha@company.com",
  "departmentId": "00000000-0000-4000-8000-000000000000",
  "jobTitle": "Engineer",
  "joiningDate": "2025-01-15"
}
```

Optional fields include `phone` and `managerId`. For an older registered account whose name is blank, HR may include both `firstName` and `lastName`; these are saved to the user account and employee profile. Existing linked employee rows with blank name columns are backfilled from their linked user.

Employee list query parameters: `page` (default 1), `limit` (default 10, max 100), `search`, `departmentId`, `employmentStatus`, `sortBy`, and `sortOrder` (`asc` or `desc`). Approved `sortBy` fields are `createdAt`, `firstName`, `lastName`, `workEmail`, `joiningDate`, and `employmentStatus`. The response includes `items` and pagination metadata (`page`, `limit`, `total`, `totalPages`).

### Departments

The department list supports `page`, `limit` (max 100), `search` (name or description), `sortBy` (`name`, `createdAt`, or `updatedAt`), and `sortOrder` (`asc` or `desc`). It returns the same pagination metadata.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/departments` | List departments. |
| GET | `/api/v1/departments/:id` | Fetch one department. |
| POST | `/api/v1/departments` | Create a department. |
| PATCH | `/api/v1/departments/:id` | Update provided department fields. |
| DELETE | `/api/v1/departments/:id` | Delete a department when database constraints allow it. |

Department reads require authentication and are available to all roles. Department create/update/delete requires admin or HR permission. Department changes are audited.

### Authorization model

The `roles`, `permissions`, and `role_permissions` tables define role-to-permission grants. `requirePermission` checks those persisted grants. Employee services additionally enforce ownership and reporting scope: ordinary employees use `/me`; managers see/update direct reports only; admin and HR can access the employee directory. Writable schemas reject unknown properties, so clients cannot mass-assign roles or unrelated fields.

| Role | Employee data | Departments | Account administration |
|---|---|---|---|
| Admin | Full access; deactivate employees | Read/manage | Assign roles, activate/deactivate accounts, revoke another user's sessions |
| HR | Full employee directory; create/update | Read/manage | Read unlinked employee accounts; cannot assign roles |
| Manager | Own profile and direct reports; limited report updates | Read | Own sessions only |
| Employee | Own profile, permitted self-updates, own JSON export | Read | Own sessions only |

## Database design

- `users`: `id`, optional legacy `first_name`/`last_name`, unique `email`, hidden `password_hash`, `role_id`, `is_active`, and timestamps. `role_id` references `roles.id` and defaults to `employee`.
- `employees`: employee name, unique `work_email`, optional phone, required `department_id`, optional self-referencing `manager_id`, job title, joining date, employment status, timestamps, and optional unique `user_id` referencing `users.id`. The optional one-to-one link lets an employee record exist before a login account is linked and lets an account exist before HR creates its employment profile. For linked users the API keeps the names in both records synchronized.
- `departments`: unique name, optional description, and timestamps. Employees must reference an existing department; a department with employees cannot be deleted.
- `roles`, `permissions`, `role_permissions`: seeded role and permission definitions with foreign keys and a composite key preventing duplicate grants.
- `refresh_tokens`: user foreign key, unique token hash, session-family ID, expiry, revocation timestamp, and creation timestamp. Only token hashes are stored.
- `audit_logs`: optional actor foreign key, action, resource, request ID, field-name metadata, and timestamp. It does not store full employee records or secrets.

PostgreSQL enforces unique emails, employee/department/manager relationships, allowed employment statuses, valid role values through the role foreign key, and the manager-not-self rule. Frequently used foreign keys, status fields, listing/search fields, session families, and audit timestamps are indexed by migrations. Employee operations follow `route → middleware → controller → service → repository → PostgreSQL`; services own business rules, strict validators allowlist writable properties, and controllers return explicit response objects rather than database entities.

## Security and behavior

- Registration cannot choose privileged roles; new accounts receive the `employee` role.
- Passwords are hashed with bcrypt.
- JWTs are checked for signature, issuer, audience, expiry, subject, and role.
- Request bodies are limited to 10 KB; rate limiting and Helmet security headers are enabled.
- All authentication and session endpoints have a stricter rate limit than the general API limit.
- CORS accepts origins listed in `CORS_ORIGINS` (comma-separated).
- Employee deletion is a soft deactivation: it sets `employment_status` to `inactive`, disables the linked account, revokes refresh tokens, and retains employee data. Department deletion may be rejected when employees still reference the department.
- Audit events store actor, action, resource, request ID, and changed field names, not passwords, token values, or full employee records.
- Production deployments must terminate HTTPS and use a managed secret store for database credentials and JWT secrets.
- The API uses explicit migrations; it does not automatically alter database schema.

## Manual API checks

Use Postman against `http://localhost:3000` after starting the server. A practical auth sequence is register, login, call a protected employee route with the returned access token, refresh using the refresh token, then try the old refresh token again (it should return 401), and logout using the newly issued refresh token.

## Create a development-only HR account

Public registration always creates a named `employee` account. To test HR-protected employee endpoints locally, set `DEV_HR_FIRST_NAME`, `DEV_HR_LAST_NAME`, `DEV_HR_EMAIL`, and `DEV_HR_PASSWORD` in your local `.env` file, then run:

```bash
npm run seed:dev-hr
```

The command works only when `NODE_ENV=development`, creates a separate HR account, hashes its password, and refuses to change an account that already exists. After it succeeds, remove the `DEV_HR_*` values from `.env`, then use that email and password with `POST /api/v1/auth/login`. Do not use this development account in production.
Seed sample departments in development with `npm run seed:dev-departments`. Roles and permission grants are installed by the permissions migration.

For local permission testing, `npm run seed:dev-admin` creates one separate development administrator from `DEV_ADMIN_*` environment values; it refuses to change an existing account and requires a password of at least 12 characters. Remove these local values after the account is created. Do not use this development seed account in production; production administrator provisioning must follow the organisation's reviewed identity and secrets process.

## Data protection and retention

See [the security and privacy report](docs/security-privacy.md) for the data inventory, role access, retention approach, and outstanding organisation-specific privacy decisions. `AUDIT_LOG_RETENTION_DAYS` controls the manual audit-log pruning command. `INACTIVE_EMPLOYEE_REVIEW_DAYS` controls a report of inactive records requiring retention review; employee records are not automatically erased because legal retention obligations vary by organisation and jurisdiction.

### API documentation

Run the API with `npm run dev`, then open `http://localhost:3000/docs` to view the Swagger UI. The UI reads the OpenAPI specification from `swagger/openapi.json`.
