# API documentation and Postman collection

- `openapi.json` is the OpenAPI 3.0 specification. Import it in Swagger Editor or Postman.
- `postman_collection.json` is a Postman v2.1 collection with per-request status and response-structure assertions, including local private document upload/list/download/delete requests.

## Postman setup

1. Import the collection. Keep `baseUrl` as `http://localhost:3000` for local development.
2. Set `testPassword` to a password that meets API rules. Run **Register**; it creates a unique named employee-role account. Run **Login** to save its access and refresh tokens.
3. Run the development account seed, sign in as HR/admin, and put the administrator's access token in `adminAccessToken`. Use **List unlinked employee accounts** to capture the registered user ID, set `departmentId` to an existing department, then run **Create employee**. Its test script saves the returned employee profile ID in `employeeId`; alternatively, **Get my linked employee profile** saves the logged-in user's profile ID. This is distinct from `employeeUserId`. Employee self-service requests use `accessToken` from the public employee login; they return/update/export only that employee's linked profile. Manager directory requests are restricted to active direct reports. Department reads require authentication; department changes require HR/admin. Session endpoints operate only on the authenticated user's sessions; admins can revoke all sessions for a selected account. Changing the password revokes all refresh sessions. Use `npm run seed:dev-admin` only in local development.
4. Requests that create, update, or delete records write to the connected database. Use development/test data only.

For document upload, set the collection `documentFile` variable to a local PDF/PNG/JPEG path, ensure `employeeId` points to an accessible profile, then run the document folder in order. The generated download URL expires after two minutes. Apply migrations before using document routes.

## Keeping docs synchronized

When routes, validators, responses, or role checks change, update the OpenAPI file and corresponding Postman requests/assertions in the same change.
