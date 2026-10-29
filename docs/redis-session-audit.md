# Redis sessions, token lifecycle, and audit events

## Authentication and revocation

Access tokens are short-lived JWTs signed with HS256. The API checks the signature, issuer, audience, and `exp` claim before trusting their claims. `JWT_CLOCK_TOLERANCE_SECONDS` defaults to zero for strict expiry and can be raised to at most five seconds when server clocks have measured drift. The `sid` claim is the refresh-token family/session ID. A valid signature alone does not prove that the user or session is still active: every protected request also checks the Redis `session:<sid>` record, then checks PostgreSQL for an active account and an unrevoked, unexpired refresh-token family. If Redis is unavailable, the API returns a controlled 503; it never skips the revocation check. PostgreSQL remains the final authority for account and family revocation.

Refresh tokens are cryptographically random opaque values. PostgreSQL stores only their SHA-256 hashes. Redis stores only token metadata under `token-meta:refresh:<sha256>`, including user ID, session ID, expiry, and revocation time. Both the Redis session record and token metadata expire at the remaining refresh-token lifetime. Access-token lifetime (`JWT_ACCESS_TTL`, at most one hour) and refresh-token lifetime (`REFRESH_TOKEN_TTL_DAYS`) are configured independently. Refresh rotates the token, marks the old hash revoked, stores metadata for the new hash, and preserves the same session ID. Reuse of a revoked token revokes the family and produces an audit event. Expired tokens are rejected at the expiry boundary; the small JWT clock tolerance applies only to the access-token `exp` check, while session and PostgreSQL expiry checks are strict.

On logout, logout-all, password change, admin revocation, or account deactivation, PostgreSQL revokes the affected token family. The Redis session is marked revoked while retaining its remaining TTL. PostgreSQL revocation and the per-request session check ensure access tokens stop working immediately rather than remaining usable until JWT expiry.

## Key names and TTLs

| Key pattern | Purpose | TTL |
| --- | --- | --- |
| `departments:all` | Default department-list cache | None; explicitly deleted after committed department mutations |
| `department:<department-id>` | Department detail cache | 5 minutes; explicitly deleted after committed updates and deletes |
| `employees:detail:*` | Employee detail cache | 5 minutes |
| `employees:list:*` | Employee list cache | 1 minute |
| `session:<session-id>` | Session ownership, expiry, and revocation metadata | Remaining refresh-token lifetime |
| `token-meta:refresh:<sha256>` | Refresh-token metadata; no raw token | Remaining token lifetime |
| `login-failures:<user-id-or-email-hash>` | Failed-login counter | `LOGIN_FAILURE_TTL_SECONDS` (default 15 minutes) |
| `doc-link-limit:<user-id>` | Presigned-download link counter | `DOCUMENT_LINK_WINDOW_SECONDS` (default 1 minute) |
| `idempotency:<request-key>` | Temporary request coordination/result | `IDEMPOTENCY_TTL_SECONDS` (default 10 minutes) |
| `session-events:expiry-pending` | Durable Redis Stream for expiry audit retries | Retained until DB processing succeeds |
| `session-events:processing-lock` | Short-lived stream-drainer lock | 30 seconds |
| `employee-api:*` | Distributed API/auth rate-limit counters | Rate-limit window |

## Expiry events and recovery

The Redis subscriber listens to key-expired notifications for `session:*` and `token-meta:refresh:*`. It places identifiers and timestamps into a Redis Stream; for token metadata, the stream carries only the full SHA-256 token hash (never the raw token) so the lifecycle service can resolve the record in PostgreSQL. Logs show only a short hash prefix. The lifecycle service writes the audit row and then acknowledges/deletes the stream entry. Audit rows have a unique `event_key`, so retries and duplicate notifications cannot duplicate an event. If PostgreSQL is down, the stream item remains queued and is retried. A periodic one-minute reconciliation job independently finds expired refresh-token families and inactive accounts, so missed notifications do not affect authentication or permanently lose the audit event. Reconciliation and stream failures are logged and counted in runtime metrics.

Redis expiry notifications are disabled by default on many Redis servers. Enable expired-key events with:

```text
CONFIG SET notify-keyspace-events Ex
```

The required flags are `E` (keyevent channel notifications) and `x` (expired events). For persistence across Redis restarts, set the equivalent value in the Redis server configuration. Some managed Redis plans do not permit `CONFIG SET`; use the provider's database configuration setting. The app logs whether its subscription is active, and reconciliation still operates if notifications cannot be enabled.

## Audit APIs

- `GET /api/v1/auth/sessions/history?page=1&limit=20` returns only the authenticated user's session events.
- `GET /api/v1/admin/session-metrics` returns 30-day aggregate counts, stored daily summaries, cache counters, and lifecycle processing counters. It requires the persisted `session:metrics` permission; the migration grants that permission only to administrators.

Audit event types are `SESSION_CREATED`, `SESSION_EXPIRED`, `SESSION_REVOKED`, `LOGOUT`, and `REFRESH_TOKEN_REUSE_DETECTED`. The table includes event/user/session IDs, event and processing timestamps, processing status, a request correlation ID, and non-secret details. Raw access tokens, refresh tokens, passwords, and session secrets are never logged or stored in Redis.

Daily summaries are generated at 00:05 UTC for the preceding UTC day and are safe to regenerate. Cache hit/miss, expiry notification/processing/retry, and reconciliation failure counters are in-process runtime metrics; they reset when a server process restarts and are not a durable monitoring backend.

## Redis configuration

Set `REDIS_URL` and, when required by the provider, `REDIS_USERNAME`, `REDIS_PASSWORD`, and `REDIS_TLS=true`. A `rediss://` URL also enables TLS. `REDIS_CONNECT_TIMEOUT_MS`, `REDIS_RETRY_ATTEMPTS`, and `REDIS_RETRY_BASE_DELAY_MS` bound connection and reconnect behavior. In production Redis is required: readiness checks Redis with `PING`, and authentication fails closed if the session store cannot be reached.

## Local Redis and expiry smoke test

Run a local Redis instance with Docker Compose (this is optional; the application itself does not require Docker):

```yaml
services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--notify-keyspace-events", "Ex"]
    ports:
      - "6379:6379"
```

Set `REDIS_URL=redis://localhost:6379` in the local environment and start the API. After logging in, inspect `session:<sid>` and `token-meta:refresh:<hash>` in Redis; confirm neither contains the raw refresh token. For a short expiry smoke test, set a temporary session key with a one-second expiry in a development Redis database and observe `Session expiry notification received`, followed by the lifecycle processing log. Do not expire a real user session in a shared or production Redis database. Reconciliation can be tested safely by expiring a test refresh-token row in the dedicated test database, then invoking the lifecycle reconciliation method in an integration test.

## Operational notes

Redis streams provide a retry queue while Redis is available; PostgreSQL remains the durable audit source. If Redis is unavailable during an expiry event, keyspace delivery may be lost, but PostgreSQL reconciliation recovers expired families. If Redis itself is unavailable during login/session creation, login fails closed and the database refresh-token row is revoked. Use a Redis deployment with persistence and backups for stronger queue durability. Cache counters are process-local, while session and token state are shared in Redis.
