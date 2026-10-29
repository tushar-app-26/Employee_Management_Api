# LAB 6: Error handling, timeouts, retries, and storage recovery

## Error handling

The API returns a stable response envelope with an HTTP status, public message, error code, timestamp, and request ID. Known application errors preserve their status and code. Validation, malformed JSON, upload-size, PostgreSQL constraint, authentication, authorization, and dependency failures map to specific responses. Unexpected failures return `500 INTERNAL_ERROR`; logs include the request ID, error name, stack, code, and bounded cause chain. Secrets, access tokens, presigned URLs, and file contents must not be logged.

Common dependency codes are `DATABASE_UNAVAILABLE` and `STORAGE_UNAVAILABLE`; request failures can be correlated from the client `requestId` to the server log. Clients should retry only transient 5xx failures, not validation or permission errors.

## Timeouts and retries

| Dependency | Current controls | Retry behavior |
| --- | --- | --- |
| PostgreSQL pool connection | `DB_CONNECT_TIMEOUT_MS` (default 5 seconds), `DB_POOL_MAX` | Startup connection retries `DB_RETRY_ATTEMPTS` (default 3) with exponential delay and jitter. |
| PostgreSQL statements | `DB_QUERY_TIMEOUT_MS` (default 5 seconds) for query, statement, and idle transaction timeout | Individual application queries are not blindly replayed; callers can retry safe requests after a transient failure. |
| AWS S3 | `S3_REQUEST_TIMEOUT_MS` for connection and socket timeout | AWS SDK uses `maxAttempts: 2` for retryable operations. |
| Presigned S3 download | `S3_PRESIGNED_URL_TTL_SECONDS` (default 300; configured 30–3600 seconds) | Generate a new URL after expiration; do not retry with an expired link. |
| Redis rate-limit store | `REDIS_CONNECT_TIMEOUT_MS` (default 5 seconds) | `REDIS_RETRY_ATTEMPTS` (default 5) with exponential backoff and jitter; production startup fails if Redis is not configured or cannot connect. |
| HTTP shutdown | `SHUTDOWN_TIMEOUT_MS` (default 10 seconds) | Graceful server and dependency close is attempted; a timer forces process exit if connections do not drain. |

Avoid retrying non-idempotent document upload requests blindly: the API generates a fresh storage key per attempt. Confirm the response or list the employee's documents before repeating after a client-side timeout.

## Redis counters and idempotency

Redis also coordinates three short-lived protections. Set the corresponding variables in `.env`; the defaults are shown below. PostgreSQL remains the permanent source of truth.

| Use case | Redis key | Default policy | Behavior |
| --- | --- | --- | --- |
| Failed login attempts | `login-failures:{userId}` (unknown emails use a SHA-256 email identifier) | `LOGIN_FAILURE_LIMIT=5`, `LOGIN_FAILURE_TTL_SECONDS=900` | Atomic increment plus expiry on the first failure. A successful login clears the counter; reaching the limit temporarily rejects more attempts with 429. |
| Download-link generation | `doc-link-limit:{userId}` | `DOCUMENT_LINK_LIMIT=10`, `DOCUMENT_LINK_WINDOW_SECONDS=60` | Atomic increment plus expiry on the first link request; requests over the configured limit receive 429. Authorization is checked before counting. |
| Employee creation and document upload | `idempotency:{hashed-actor-scope-key}` | `IDEMPOTENCY_TTL_SECONDS=600` | Send an `Idempotency-Key` header. Redis atomically claims the key; concurrent duplicates receive 409 while processing, completed identical requests replay the stored response, and reusing a key with a different payload receives 409. Failed operations release their claim when possible. |

The idempotency header is optional for backwards compatibility. A Redis claim prevents ordinary concurrent retries from running the operation twice, but Redis and PostgreSQL do not share a transaction. A process crash after the database commits but before Redis stores the completed result can leave a temporary processing key; this is not a strict exactly-once guarantee. For workflows requiring recovery across that failure window, add a durable PostgreSQL idempotency record written in the same transaction as the business data.

## S3 storage and recovery

Production uses an S3 bucket with public access blocked. Uploads use server-generated UUID keys, validated content types, and server-side AES-256 encryption. PostgreSQL stores document metadata and the object key. The API returns only short-lived presigned GET URLs after checking employee access. The API's IAM identity needs object-level `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` for the configured bucket prefix; it does not need public ACLs or bucket-wide administration.

### Recovery procedures

1. **Upload returns 503:** use the response request ID to find the `Document storage upload failed` log. Check AWS region/bucket, IAM object permissions, network reachability, and bucket encryption policy. Do not paste credentials into tickets or chat.
2. **Object exists without a database row:** database persistence failed after object upload. The service attempts to delete the new object. If cleanup also fails, the log includes the generated storage key; reconcile that exact key after checking that no metadata row references it.
3. **Database row points to a missing object:** verify object key, region, retention, and delete audit history. Restore the object from S3 versioning/backup if enabled; otherwise contact the file owner for re-upload. Do not create a replacement metadata row before confirming the storage key.
4. **Delete operation leaves an orphan object:** compare object keys with `employee_documents.storage_filename`; remove only confirmed unreferenced keys under the approved retention process.
5. **Expired download URL:** request a new link through the authenticated API. Never make the bucket public to work around a failed presigned URL.

For recoverability, enable S3 bucket versioning and an appropriate lifecycle/backup policy outside the application. Keep database backups and object version retention aligned. Test restore procedures with non-production documents and record who performed the recovery.

## Deployment checklist

- Set `DOCUMENT_STORAGE_DRIVER=s3`, the matching AWS region and bucket, and credentials via a secret manager or workload IAM role.
- Keep S3 public access blocked and grant only the application role the required object permissions.
- Configure `REDIS_URL` for every production replica; all replicas must point at the same Redis service.
- Tune `LOGIN_FAILURE_LIMIT`, `LOGIN_FAILURE_TTL_SECONDS`, `DOCUMENT_LINK_LIMIT`, `DOCUMENT_LINK_WINDOW_SECONDS`, and `IDEMPOTENCY_TTL_SECONDS` for the deployment and its user experience.
- Tune database, S3, Redis, and shutdown timeout values to the deployment environment.
- Alert on sustained `DATABASE_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, Redis disconnects, failed cleanup logs, and orphan/missing-object reconciliation.
- Keep `.env` and actual Postman environments out of source control; commit only templates with empty secret values.
