# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

Explain:

1. why database uniqueness is needed;
2. how request contents are canonicalized and compared;
3. what 24-hour expiry means;
4. why paging job is stored in same transaction;
5. privacy and size risks of stored responses.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Design Decisions (implementation)

### Endpoint contract

`POST /incidents` requires `Idempotency-Key` (1–255 visible ASCII characters, e.g. a UUIDv4). Clients send **one key per logical incident** and reuse it on every retry.

| Situation | Response |
|---|---|
| No key | `400 idempotency_key_required` (key too long or with spaces → `400 idempotency_key_invalid`) |
| Invalid body | `422 validation_failed`. Checked **before** the key is claimed, so the key isn't used up |
| First request | `201` + incident; key stored as `completed` with its response |
| Same key, same request, completed | Stored `201` body replayed byte-for-byte, with `Idempotent-Replayed: true`. Nothing runs again |
| Same key, **different** request | `409 idempotency_key_conflict` |
| Same key, still `processing` | `409 operation_in_progress` + `Retry-After: 1`. Never runs concurrently |
| Same key, `failed` | `409 prior_operation_failed`. The client must use a new key to try again |
| Key older than 24 h | Treated as unseen: the key is reclaimed and the request runs again |

**Scope** is `(tenant_id, operation, key)`. `tenant_id` comes from authentication (`req.user`), never from the body, and `operation` is the constant `'POST:/incidents'`. The same key in two tenants, or on a different endpoint, refers to two unrelated operations.

### 1. Why database uniqueness is needed

A "look it up first, then insert" check is not enough. Twenty retries arriving in the same millisecond can all read "key not seen" and all create an incident. The authority is the `UNIQUE (tenant_id, operation, key)` constraint, used through a single atomic claim:

```sql
INSERT INTO idempotency_keys (...) VALUES (..., 'processing', now() + interval '24 hours')
ON CONFLICT ON CONSTRAINT idempotency_keys_scope_unique DO UPDATE ...
  WHERE idempotency_keys.expires_at <= now()   -- only an expired key can be reclaimed
RETURNING id
```

Exactly one request gets a row back and owns the key. Every concurrent duplicate **blocks on the winner's uncommitted row** until the winner commits, then reads the completed record and replays it. If the winner rolls back, the next request in line claims the key itself. No request writes an incident before it owns the key. `paging_jobs` has a second safety net, `UNIQUE (incident_id)`, so one incident can never get two paging jobs.

Verified beyond the supplied tests: 100 concurrent identical requests produced 100 × `201` with one incident ID, 1 incident row and 1 paging job.

### 2. How request contents are canonicalized and compared

`hashRequest(body)`:

1. Takes **only the fields that define the incident**: `title`, `severity`, `serviceId`.
2. Normalises them exactly as they are stored: `title` is trimmed, `serviceId` is lower-cased (UUIDs are case-insensitive), and `severity` is used as-is.
3. Serialises them as JSON with **keys in sorted order**.
4. Hashes the result with **SHA-256**.

So property order, letter case in the UUID, and surrounding whitespace don't change the hash. Any real change in intent (a different title, severity or service) does, and produces `409 idempotency_key_conflict`. Unknown extra fields are ignored because they never reach the stored incident and can't change the outcome. The stored value is the hash only, not the raw request.

### 3. What the 24-hour expiry means

Every key row has `expires_at = created_at + 24 hours`. **Within** 24 hours, a retry with the same key is guaranteed to replay the original result. **After** 24 hours, the key no longer protects anything: the claim's `WHERE expires_at <= now()` lets a new request take the key over and create a new incident. That is deliberate. 24 hours is far longer than any realistic client retry (seconds to minutes, or an app reopened later that day), and it bounds storage. A cleanup job can `DELETE FROM idempotency_keys WHERE expires_at < now()` using `idx_idempotency_keys_expires_at`. Clients must not reuse a key for a new incident, and must not expect duplicate protection after the window.

### 4. Why the paging job is stored in the same transaction

The key claim, the incident, the paging job and the stored response are written in **one transaction**, so either all four exist or none do:

- A crash after the incident is created but before the page is queued can't leave an incident that **never pages anyone**.
- A failed transaction can't leave a paging job for an incident that **doesn't exist**.
- An unexpected error rolls back the key claim too, so a retry runs cleanly rather than getting stuck. (Verified by forcing the paging-job insert to fail: `500`, no key, no incident, and the retry then created exactly one of each.)

The handler **does not call the paging provider** inside the transaction: a slow provider would hold database locks, and a rollback can't un-send a page. A separate worker delivers `pending` jobs after commit. It uses the job's stable `id` as the provider's idempotency key, so a worker retry can't double-page responders either.

**About the `processing` and `failed` states:** because everything commits together, this handler never leaves a `processing` row committed and never writes `failed` for an unexpected error (it rolls back instead). Both states are still part of the contract and enforced. `processing` covers a future asynchronous design or a seeded row. `failed` covers a recorded permanent failure, where silently re-running could cause harm. Both return `409`, never a second execution.

### 5. Privacy and size risks of stored responses

`response_body` stores the full `201` body so a replay is exact. (It is `JSON`, not `JSONB`, because `JSONB` re-sorts keys and the replay would no longer be byte-identical.) Risks:

- **Privacy:** the stored body copies incident data, including the free-text `title`, into a second table that lives for 24 hours. That data must get the same access control, encryption and deletion handling (e.g. erasure requests) as `incidents`. Replays are tenant-scoped, so another tenant can never read it. Within one tenant, any user who sends the same key gets the replay, so keys must be unguessable (UUIDv4).
- **Size:** one stored response per request for 24 hours. At high traffic, or with large bodies, this table grows fast, so the expiry cleanup job is required, not optional. Only small, bounded bodies should be stored. Secrets, tokens and large payloads must never go into `response_body`. If a response grows large, store the incident ID and rebuild the response on replay.

### Files changed

- `db/schema.sql`: `idempotency_keys` (scoped unique key, request hash, state, replay metadata, expiry) and `paging_jobs` (durable job, one per incident).
- `src/incidents.js`: key validation, canonical hash (`hashRequest` exported), atomic claim, replay, conflict and processing/failed responses, and the single transaction.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
