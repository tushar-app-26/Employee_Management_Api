# Security and privacy report

This report describes safeguards implemented in this training API. It is an engineering summary, not a determination that an organisation complies with GDPR or any other law. The deploying organisation must confirm its lawful basis, notices, processor agreements, rights handling, retention periods, and security requirements with its privacy/legal reviewers.

## Data inventory

| Data | Purpose | Access | Retention / correction |
|---|---|---|---|
| User name and email | Identify account holder and support login | A linked user can view/update name through self-service; admin can manage access; HR can see unlinked employee accounts | Retain while account exists. Correct through linked self-service or an admin-verified request; email changes require a verified process before enabling that feature. |
| Password hash | Authenticate account holder | Authentication service only; ORM does not select it by default; never returned | Keep while account exists; replace on password change; remove under approved account-erasure workflow. |
| Role and active status | Enforce access policy and disable accounts | Read by authentication/authorization middleware; changes restricted to admin and audited | Retain while account exists; every role/status change revokes refresh sessions. |
| Employee name, work email, phone | Identify staff and support employment operations | Employee sees own profile; manager sees direct reports; HR/admin see directory | Collect only needed fields. Correct through self-service for name/phone or HR/admin for employment records. Inactive records are reviewed after `INACTIVE_EMPLOYEE_REVIEW_DAYS`; deletion/anonymisation requires organisation approval. |
| Department, manager, title, joining date, status | Run employee-management workflows | HR/admin full access; managers see direct reports; employee sees own record | Retain according to employment-record obligations selected by the organisation; review inactive/terminated records on the configured interval. |
| Refresh-token hash, family, expiry, revocation | Maintain and revoke login sessions | Authentication/session services only | Expired/revoked values are security metadata; remove under operational retention policy. Raw refresh tokens are never stored. |
| Audit action, actor, resource, request ID, field names | Investigate sensitive administrative changes | Database operators and authorised auditors | `AUDIT_LOG_RETENTION_DAYS` configures pruning; `npm run audit:prune` deletes older events. The command is manual so an approved policy can govern scheduling. |
| Employee document file and metadata | Support employment administration and employee-submitted records | Admin/HR, permitted direct-report managers, and the employee for their own linked profile | Local-development file storage is private and excluded from Git; delete through the authorised document endpoint according to the approved records schedule. Production requires private object storage and organisation-defined retention. |

## Safeguards

- Passwords use bcrypt with a work factor of 12. Access JWTs are short-lived and checked for signature, expiry, issuer, audience, subject, and role shape.
- Refresh tokens are generated with a cryptographic random source; only SHA-256 hashes are stored. Access tokens are bound to a refresh-token family, so rotation keeps the active access session while logout, family reuse detection, password change, account deactivation, role changes, and admin-directed account revocation invalidate it server-side.
- Protected requests reload the account's current role and active state. This prevents stale JWT claims from preserving access after a role change or deactivation.
- Database-backed permissions are checked by middleware. Employee services additionally restrict employees to their own profile and managers to their direct reports. HR/admin directory access and admin-only account changes are enforced on the backend.
- Request schemas are strict and allowlist writable properties. TypeORM parameter binding is used for user-supplied filters/IDs. PostgreSQL constraints enforce uniqueness and relationships.
- Helmet, explicit CORS origins, request-size limits, general and authentication-specific rate limits, generic credential failures, request IDs, and central safe error responses are enabled.
- Logs avoid request bodies, credentials, token values, employee field values, and SQL parameters. Audit events retain only action metadata and changed field names.
- The API uses JSON bearer refresh tokens. Clients must protect them in platform secure storage; browser deployments should adopt HttpOnly cookies with CSRF protection before use.
- Local document files are stored outside the public web root, with server-generated filenames, a size cap, extension/MIME/signature checks, and short-lived signed download links. Local disk is a development adapter only; production needs private object storage, backups, and an approved document-retention policy.

## Retention and rights handling

Audit logs are pruned after the configured number of days using `AUDIT_LOG_RETENTION_DAYS`. `npm run retention:report` counts inactive/terminated employee records older than `INACTIVE_EMPLOYEE_REVIEW_DAYS` without displaying identities or deleting records. This report is a review queue, not an automatic erasure rule. Employment records may have statutory retention obligations; an authorised organisation process must assess erasure, restriction, correction, and legal holds case by case.

The authenticated `GET /api/v1/employees/me/export` endpoint returns the caller's own account and linked employee profile as JSON. Self-service profile correction supports the caller's name and phone; HR/admin can correct employment details. Account-email correction is not exposed until a verified email-change workflow is designed. Requests to access, correct, restrict, or erase data should be identity-verified and recorded through the organisation's established process.

## Threats and unresolved decisions

| Threat / question | Current control | Still needs organisation review |
|---|---|---|
| Credential theft or guessing | bcrypt, generic login errors, auth rate limit, short-lived access token | MFA, breached-password screening, lockout/risk policies |
| Stolen refresh token replay | Hash at rest, rotation, family revocation, logout/session controls, family-bound access tokens | Incident response and user notification procedure |
| Broken object/function authorization | Database permission checks and service-level ownership/reporting-scope checks | Validate the role matrix against actual HR policies |
| Sensitive logs or excessive collection | Minimal audit payloads; no full employee objects in logs | Review every added field/integration before collection |
| Unauthorised transport/storage | CORS and bearer-token guidance | HTTPS termination, secret manager, backups, key rotation, and client secure storage in deployment |
| Retention/erasure conflict | Configurable audit pruning and inactive-record review report | Set lawful basis, notices, exact schedules, legal holds, and erasure exceptions with privacy/legal staff |
| High-privilege actions | Admin-only role/status endpoint and audit records | Define admin provisioning/recovery and audit-log access controls |
