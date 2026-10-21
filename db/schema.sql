CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per logical operation a client asked for, scoped to the authenticated
-- tenant and the operation. The UNIQUE constraint is the concurrency authority:
-- of any number of simultaneous requests with the same scoped key, exactly one
-- can insert this row and go on to create the incident.
CREATE TABLE idempotency_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  operation       TEXT        NOT NULL,                 -- e.g. 'POST:/incidents'
  key             TEXT        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash    TEXT        NOT NULL,                 -- SHA-256 of the canonical request
  state           TEXT        NOT NULL CHECK (state IN ('processing','completed','failed')),
  response_status INTEGER,                              -- replay metadata, set on completion
  response_body   JSON,                                 -- JSON, not JSONB: keeps the exact text, so replays are byte-identical
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,                 -- created_at + 24h for this exercise
  CONSTRAINT idempotency_keys_scope_unique UNIQUE (tenant_id, operation, key),
  -- A completed key must be replayable.
  CONSTRAINT idempotency_keys_completed_has_response
    CHECK (state <> 'completed' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);

-- Supports the cleanup job that removes expired keys.
CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);

-- Durable outbox row for the paging side effect. Written in the same transaction
-- as the incident; a separate worker delivers it after commit, never inside it.
CREATE TABLE paging_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),  -- stable ID the worker sends downstream as its own idempotency key
  tenant_id    UUID        NOT NULL,
  incident_id  UUID        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts     INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT paging_jobs_one_per_incident UNIQUE (incident_id)   -- second safety net: never two pages for one incident
);

-- Worker polls pending jobs oldest first.
CREATE INDEX idx_paging_jobs_pending ON paging_jobs (created_at) WHERE status = 'pending';
