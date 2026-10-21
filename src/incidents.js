const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const KEY_TTL = '24 hours';
const MAX_KEY_LENGTH = 255;
const SEVERITIES = ['P1', 'P2', 'P3', 'P4'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Visible ASCII only: keys are opaque, but must survive headers, logs and indexes unchanged.
const KEY_RE = /^[\x21-\x7E]+$/;

/**
 * The fields that define "which incident is being created". Only these are
 * stored, so only these take part in the hash: an extra unknown field in a
 * retry doesn't change the outcome and isn't treated as a different request.
 * Values are normalised the same way they are stored.
 */
function canonicalize(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    serviceId: typeof b.serviceId === 'string' ? b.serviceId.toLowerCase() : b.serviceId,
    severity: b.severity,
    title: typeof b.title === 'string' ? b.title.trim() : b.title,
  };
}

/** SHA-256 over canonical JSON with sorted keys, so property order never matters. */
function hashRequest(body) {
  const canonical = canonicalize(body);
  const sorted = Object.keys(canonical).sort().map(k => [k, canonical[k] === undefined ? null : canonical[k]]);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function validate(input) {
  const errors = [];
  if (typeof input.title !== 'string' || input.title.length === 0) errors.push('title must be a non-empty string');
  if (!SEVERITIES.includes(input.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (typeof input.serviceId !== 'string' || !UUID_RE.test(input.serviceId)) errors.push('serviceId must be a UUID');
  return errors;
}

async function createIncident(req, res) {
  // 1. A key is required: without one, a lost response can never be recognised as a retry.
  const key = req.get('Idempotency-Key');
  if (key === undefined || key === '') {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }
  if (key.length > MAX_KEY_LENGTH || !KEY_RE.test(key)) {
    return res.status(400).json({ error: 'idempotency_key_invalid' });
  }

  // 2. Validate before claiming the key, so a rejected request doesn't use it up.
  const input = canonicalize(req.body);
  const errors = validate(input);
  if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

  // 3. Scope comes from authentication, never from the request body.
  const { tenantId } = req.user;
  const requestHash = hashRequest(req.body);

  // 4. Claim the key, create the incident and its paging job, and record the
  //    response, all in one transaction. The response is sent only after commit.
  const outcome = await db.tx(async t => {
    // Atomic claim. INSERT ... ON CONFLICT relies on the unique constraint: a
    // concurrent duplicate blocks here until the winner commits (then gets no
    // row back) or rolls back (then claims the key itself). An expired key may
    // be reclaimed, which is the documented 24-hour expiry behaviour.
    const claimed = await t.oneOrNone(
      `INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + $5::interval)
       ON CONFLICT ON CONSTRAINT idempotency_keys_scope_unique DO UPDATE
         SET request_hash = EXCLUDED.request_hash, state = 'processing',
             response_status = NULL, response_body = NULL, completed_at = NULL,
             created_at = now(), expires_at = EXCLUDED.expires_at
         WHERE idempotency_keys.expires_at <= now()
       RETURNING id`,
      [tenantId, OPERATION, key, requestHash, KEY_TTL]
    );

    if (!claimed) {
      // Someone else owns this key: decide from its stored state, never re-execute.
      const existing = await t.one(
        `SELECT request_hash, state, response_status, response_body
           FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, OPERATION, key]
      );
      if (existing.request_hash !== requestHash) {
        return { status: 409, body: { error: 'idempotency_key_conflict', message: 'This Idempotency-Key was already used with a different request.' } };
      }
      if (existing.state === 'completed') {
        return { status: existing.response_status, body: existing.response_body, replayed: true };
      }
      if (existing.state === 'processing') {
        return { status: 409, body: { error: 'operation_in_progress' }, retryAfter: 1 };
      }
      return { status: 409, body: { error: 'prior_operation_failed', message: 'The original request with this key failed. Send a new Idempotency-Key to try again.' } };
    }

    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, input.serviceId, input.title, input.severity]
    );

    // Durable paging job in the same transaction: it exists if and only if the
    // incident does. The worker delivers it after commit.
    await t.none(
      `INSERT INTO paging_jobs (tenant_id, incident_id) VALUES ($1, $2)`,
      [tenantId, incident.id]
    );

    // Store exactly what we return, so a replay is byte-for-byte the same body.
    const body = JSON.parse(JSON.stringify(incident));
    await t.none(
      `UPDATE idempotency_keys
          SET state = 'completed', response_status = 201, response_body = $2, completed_at = now()
        WHERE id = $1`,
      [claimed.id, body]
    );
    return { status: 201, body };
  });

  if (outcome.replayed) res.set('Idempotent-Replayed', 'true');
  if (outcome.retryAfter) res.set('Retry-After', String(outcome.retryAfter));
  return res.status(outcome.status).json(outcome.body);
}

module.exports = { createIncident, hashRequest };
