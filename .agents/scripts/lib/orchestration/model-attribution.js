/**
 * model-attribution.js — per-ticket model attribution comments + rollup
 * (Story #2813).
 *
 * Records which Claude model executed a given ticket as a structured comment
 * on that ticket. Epic-level mixes are computed at query time by walking the
 * child tickets' comments — no Epic-scope emission is written.
 *
 * Surface:
 *
 *   - {@link resolveModelIdentity} — pure resolver that picks an identity
 *     from the fallback chain (SDK metadata → env var → 'unknown'
 *     sentinel) and tags the source. Pure: no IO, no Date.now().
 *   - {@link buildModelAttributionPayload} — shape the canonical payload
 *     from a resolved identity + ticketId + timestamp.
 *   - {@link validateModelAttributionPayload} — hand-rolled validator
 *     matching `.agents/schemas/model-attribution.schema.json`. Returns
 *     `{ ok: true }` or `{ ok: false, errors: string[] }`.
 *   - {@link renderModelAttributionBody} — markdown body + fenced JSON
 *     block (same fence convention as the other structured comments in
 *     this repo so the shared `parseFencedJsonComment` can read it back).
 *   - {@link emitModelAttribution} — idempotent upsert against a Task
 *     ticket. Throws on validator failure (no comment written).
 *   - {@link parseModelAttributionComment} — readback helper for the
 *     rollup walker; returns `null` on missing/malformed payloads.
 *   - {@link rollupModelAttribution} — given a Story or Epic ticket id,
 *     walks `getSubTickets`, collects attribution comments, returns
 *     `{ totalChildren, byModel: {...}, missing: N }`.
 */

import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment, upsertStructuredComment } from './ticketing.js';

export const MODEL_ATTRIBUTION_TYPE = 'model-attribution';

/**
 * Sentinel returned by {@link resolveModelIdentity} when neither the SDK
 * metadata nor the runtime env var supplied a model id. Exported so tests
 * and downstream consumers can compare without re-spelling the literal.
 */
export const UNKNOWN_MODEL_ID = 'unknown';

/**
 * Env vars consulted as the second-priority resolver source. Listed in
 * priority order — the first one set wins.
 */
const ENV_VAR_CANDIDATES = Object.freeze(['CLAUDE_MODEL', 'ANTHROPIC_MODEL']);

/**
 * Derive the coarse family label from a canonical model id. Used for the
 * rollup-friendly `family` field. Returns `null` when the id does not
 * match a recognised family pattern (the rollup helper falls back to the
 * full id in that case so unknown models still aggregate distinctly).
 *
 * Recognises Anthropic Claude families: Opus, Sonnet, Haiku.
 *
 * @param {string} id
 * @returns {string | null}
 */
export function deriveFamily(id) {
  if (typeof id !== 'string') return null;
  const lower = id.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  return null;
}

/**
 * Resolve the active model identity using the documented fallback chain:
 *
 *   1. `sdkMetadata.modelId` (or `.model`) when present and non-empty.
 *   2. `CLAUDE_MODEL` / `ANTHROPIC_MODEL` env vars (first non-empty wins).
 *   3. The `UNKNOWN_MODEL_ID` sentinel.
 *
 * Pure: accepts the env bag as an injectable argument so tests can pin
 * the resolver without mutating `process.env`. Production callers default
 * to `process.env`.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.sdkMetadata] — SDK response metadata.
 * @param {Record<string, string|undefined>} [opts.env=process.env]
 * @returns {{ id: string, family: string|null, source: 'sdk-metadata'|'env'|'unknown', sdkMetadata?: object }}
 */
export function resolveModelIdentity(opts = {}) {
  const { sdkMetadata = null, env = process.env } = opts;

  const sdkId =
    sdkMetadata && typeof sdkMetadata === 'object'
      ? (typeof sdkMetadata.modelId === 'string' && sdkMetadata.modelId) ||
        (typeof sdkMetadata.model === 'string' && sdkMetadata.model) ||
        null
      : null;
  if (sdkId) {
    return {
      id: sdkId,
      family: deriveFamily(sdkId),
      source: 'sdk-metadata',
      sdkMetadata,
    };
  }

  for (const name of ENV_VAR_CANDIDATES) {
    const value = env?.[name];
    if (typeof value === 'string' && value.length > 0) {
      return {
        id: value,
        family: deriveFamily(value),
        source: 'env',
      };
    }
  }

  return {
    id: UNKNOWN_MODEL_ID,
    family: null,
    source: 'unknown',
  };
}

/**
 * Build the canonical payload object from a resolved identity. Separated
 * from {@link emitModelAttribution} so callers (and tests) can shape the
 * payload without triggering the upsert side-effect.
 *
 * @param {{
 *   ticketId: number,
 *   identity: ReturnType<typeof resolveModelIdentity>,
 *   recordedAt?: string,
 * }} args
 * @returns {object}
 */
export function buildModelAttributionPayload(args) {
  const { ticketId, identity, recordedAt } = args ?? {};
  const payload = {
    kind: MODEL_ATTRIBUTION_TYPE,
    ticketId,
    model: identity?.family
      ? { id: identity.id, family: identity.family }
      : { id: identity?.id },
    source: identity?.source,
    recordedAt: recordedAt ?? new Date().toISOString(),
  };
  if (identity?.sdkMetadata && typeof identity.sdkMetadata === 'object') {
    payload.sdkMetadata = identity.sdkMetadata;
  }
  return payload;
}

const VALID_SOURCES = new Set(['sdk-metadata', 'env', 'unknown']);
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Per-field validators for {@link validateModelAttributionPayload}. Each
 * returns an array of error strings for its field (empty when the field is
 * valid), so the top-level validator collapses to a flat-map over the field
 * list — no per-field branching in the orchestrating body. Story #4075
 * (CLI-orchestration CC reduction): keeps each validator pure and
 * single-responsibility.
 */
function validateKind(payload) {
  return payload.kind === MODEL_ATTRIBUTION_TYPE
    ? []
    : [`kind must be "${MODEL_ATTRIBUTION_TYPE}"`];
}

function validateTicketId(payload) {
  return Number.isInteger(payload.ticketId) && payload.ticketId > 0
    ? []
    : ['ticketId must be a positive integer'];
}

function validateModel(payload) {
  const { model } = payload;
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return ['model must be an object'];
  }
  const errors = [];
  if (typeof model.id !== 'string' || model.id.length === 0) {
    errors.push('model.id must be a non-empty string');
  }
  if (
    model.family !== undefined &&
    (typeof model.family !== 'string' || model.family.length === 0)
  ) {
    errors.push('model.family, when present, must be a non-empty string');
  }
  return errors;
}

function validateSource(payload) {
  return typeof payload.source === 'string' && VALID_SOURCES.has(payload.source)
    ? []
    : [`source must be one of: ${[...VALID_SOURCES].join(', ')}`];
}

function validateRecordedAt(payload) {
  return typeof payload.recordedAt === 'string' &&
    ISO_8601_RE.test(payload.recordedAt)
    ? []
    : ['recordedAt must be an ISO-8601 timestamp string'];
}

function validateSdkMetadata(payload) {
  const { sdkMetadata } = payload;
  if (sdkMetadata === undefined) return [];
  const valid =
    sdkMetadata !== null &&
    typeof sdkMetadata === 'object' &&
    !Array.isArray(sdkMetadata);
  return valid ? [] : ['sdkMetadata, when present, must be an object'];
}

const PAYLOAD_FIELD_VALIDATORS = Object.freeze([
  validateKind,
  validateTicketId,
  validateModel,
  validateSource,
  validateRecordedAt,
  validateSdkMetadata,
]);

/**
 * Hand-rolled validator matching
 * `.agents/schemas/model-attribution.schema.json`. Returns
 * `{ ok: true }` on success, `{ ok: false, errors: string[] }` on
 * failure. The error strings are stable enough to assert against in
 * tests.
 *
 * The codebase does not pull in `ajv` for runtime schema validation
 * (signals + structured comments use hand-rolled shape guards — see
 * `lib/signals/schema.js`). We follow the same pattern here so the
 * schema file stays the documented SSOT and the validator is the
 * runtime gate.
 *
 * @param {unknown} payload
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateModelAttributionPayload(payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return { ok: false, errors: ['payload must be a plain object'] };
  }
  const errors = PAYLOAD_FIELD_VALIDATORS.flatMap((validate) =>
    validate(payload),
  );
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Render the markdown body that gets upserted as the structured comment.
 * Body is a one-line summary followed by the canonical payload inside a
 * fenced ```json``` block so downstream readers can use the shared
 * `parseFencedJsonComment` helper without bespoke parsing.
 *
 * @param {object} payload — already validated.
 * @returns {string}
 */
export function renderModelAttributionBody(payload) {
  const id = payload.model?.id ?? UNKNOWN_MODEL_ID;
  const family = payload.model?.family ? ` (${payload.model.family})` : '';
  const sourceLabel =
    payload.source === 'sdk-metadata'
      ? 'SDK metadata'
      : payload.source === 'env'
        ? 'env var'
        : 'unknown source';
  const header = `🤖 Model attribution: \`${id}\`${family} · via ${sourceLabel}`;
  return [header, '', '```json', JSON.stringify(payload, null, 2), '```'].join(
    '\n',
  );
}

/**
 * Emit (idempotently) the model-attribution comment onto a Task ticket.
 * Validates the payload before any IO — a malformed payload throws and
 * writes nothing to the provider.
 *
 * @param {{
 *   provider: import('../ITicketingProvider.js').ITicketingProvider,
 *   ticketId: number,
 *   sdkMetadata?: object|null,
 *   env?: Record<string, string|undefined>,
 *   recordedAt?: string,
 * }} args
 * @returns {Promise<{ payload: object, body: string }>}
 */
export async function emitModelAttribution(args) {
  const { provider, ticketId, sdkMetadata, env, recordedAt } = args ?? {};
  if (!provider || typeof provider.postComment !== 'function') {
    throw new TypeError(
      'emitModelAttribution requires a provider with postComment',
    );
  }
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new TypeError(
      'emitModelAttribution requires a positive integer ticketId',
    );
  }
  const identity = resolveModelIdentity({ sdkMetadata, env });
  const payload = buildModelAttributionPayload({
    ticketId,
    identity,
    recordedAt,
  });
  const result = validateModelAttributionPayload(payload);
  if (!result.ok) {
    throw new Error(
      `model-attribution payload failed validation: ${result.errors.join('; ')}`,
    );
  }
  const body = renderModelAttributionBody(payload);
  await upsertStructuredComment(
    provider,
    ticketId,
    MODEL_ATTRIBUTION_TYPE,
    body,
  );
  return { payload, body };
}

/**
 * Read back a model-attribution comment from a ticket. Returns the
 * parsed payload, or `null` when the comment is missing or its payload
 * fails validation (malformed payloads are treated as "no attribution"
 * so a single corrupt comment does not poison the whole rollup).
 *
 * @param {{
 *   provider: import('../ITicketingProvider.js').ITicketingProvider,
 *   ticketId: number,
 * }} args
 * @returns {Promise<object|null>}
 */
export async function parseModelAttributionComment(args) {
  const { provider, ticketId } = args ?? {};
  const comment = await findStructuredComment(
    provider,
    ticketId,
    MODEL_ATTRIBUTION_TYPE,
  );
  if (!comment) return null;
  const parsed = parseFencedJsonComment(comment);
  if (!parsed) return null;
  const result = validateModelAttributionPayload(parsed);
  return result.ok ? parsed : null;
}

/**
 * Walk the immediate child tickets of a parent (e.g. an Epic's Stories),
 * read each child's model-attribution comment (when present), and
 * aggregate per-model counts. Children with no attribution comment are
 * counted under `missing`.
 *
 * Rollup is keyed by `model.family` when present, otherwise by
 * `model.id` so unknown families still aggregate distinctly. The
 * envelope also exposes the per-id breakdown for callers that want a
 * finer-grained view.
 *
 * @param {{
 *   provider: import('../ITicketingProvider.js').ITicketingProvider,
 *   parentId: number,
 * }} args
 * @returns {Promise<{
 *   parentId: number,
 *   totalChildren: number,
 *   missing: number,
 *   byModel: Record<string, number>,
 *   byId: Record<string, number>,
 * }>}
 */
export async function rollupModelAttribution(args) {
  const { provider, parentId } = args ?? {};
  if (!provider || typeof provider.getSubTickets !== 'function') {
    throw new TypeError(
      'rollupModelAttribution requires a provider with getSubTickets',
    );
  }
  if (!Number.isInteger(parentId) || parentId <= 0) {
    throw new TypeError(
      'rollupModelAttribution requires a positive integer parentId',
    );
  }
  const children = (await provider.getSubTickets(parentId)) ?? [];
  const byModel = {};
  const byId = {};
  let missing = 0;
  for (const child of children) {
    const childId = Number(child?.id);
    if (!Number.isInteger(childId) || childId <= 0) {
      missing += 1;
      continue;
    }
    const payload = await parseModelAttributionComment({
      provider,
      ticketId: childId,
    });
    if (!payload) {
      missing += 1;
      continue;
    }
    const familyKey =
      payload.model?.family ?? payload.model?.id ?? UNKNOWN_MODEL_ID;
    const idKey = payload.model?.id ?? UNKNOWN_MODEL_ID;
    byModel[familyKey] = (byModel[familyKey] ?? 0) + 1;
    byId[idKey] = (byId[idKey] ?? 0) + 1;
  }
  return {
    parentId,
    totalChildren: children.length,
    missing,
    byModel,
    byId,
  };
}
