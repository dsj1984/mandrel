/**
 * QA exploratory-session resume helper — Story #3723, Epic #3686.
 *
 * A `/qa-explore` run captures observations into a per-session ledger
 * (one `QaLedgerItem` per line, see `.agents/schemas/qa-ledger.schema.json`
 * from Story #3716). For an f5-safety resume to work, a later run with the
 * *same* session-id must read the on-disk ledger, carry forward the still
 * un-triaged findings as a rolling backlog, and append to — never overwrite —
 * the existing file.
 *
 * This module owns three small seams:
 *   - {@link resolveSessionId}  — a stable session-id for a run.
 *   - {@link ledgerPathFor}     — the ledger path under `<tempRoot>/qa/`.
 *   - {@link readLedger}        — parse an existing ledger into items plus the
 *                                 un-triaged subset (the rolling backlog).
 *
 * {@link resolveQaSession} composes them: it resolves the id and path, reads
 * any existing ledger, and reports whether the file already existed so the
 * caller knows to *reuse* rather than re-create it.
 *
 * Evidence persisted in the ledger MUST already be scrubbed of secrets and
 * PII per `.agents/rules/security-baseline.md` (see `lib/qa/redact-evidence.js`)
 * before it reaches disk; this module only reads what is already there.
 *
 * The ledger round-trip is field-preserving: {@link readLedger} parses each
 * line as a whole `QaLedgerItem` and returns it untouched, so optional fields
 * such as the Triage `routedTo` finding-to-issue link
 * (see `.agents/schemas/qa-ledger.schema.json`) survive a read/append cycle
 * intact rather than being dropped on resume.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { tempRootFrom } from '../config/temp-paths.js';

/** Directory segment (under `tempRoot`) that holds every QA session ledger. */
export const QA_LEDGER_DIRNAME = 'qa';

/**
 * Triaged dispositions, mirrored from the `disposition` enum in
 * `.agents/schemas/qa-ledger.schema.json`. An item carrying any of these has
 * already been triaged; anything else (absent, null, empty, or unrecognized)
 * is still part of the rolling backlog.
 */
export const TRIAGED_DISPOSITIONS = Object.freeze(['file', 'defer', 'dismiss']);

/**
 * True when a ledger item has **not** yet been triaged — i.e. its
 * `disposition` is not one of the canonical triaged values. These items are
 * the rolling backlog a resume run carries forward.
 *
 * @param {{ disposition?: unknown }} item
 * @returns {boolean}
 */
export function isUntriaged(item) {
  const disposition = item?.disposition;
  return !TRIAGED_DISPOSITIONS.includes(disposition);
}

/**
 * Normalize an arbitrary session label into a filesystem-safe slug. Keeps
 * alphanumerics, dot, dash, and underscore; collapses everything else to a
 * single dash. Guards against path traversal so a hostile label can never
 * escape the `qa/` directory.
 *
 * @param {string} raw
 * @returns {string}
 */
function slugifySessionId(raw) {
  const slug = String(raw)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug : deriveSessionId();
}

/**
 * Derive a fresh, stable session-id when the caller supplies none. The id is
 * date-prefixed for human scannability and suffixed with short entropy so two
 * runs on the same day never collide.
 *
 * @returns {string}
 */
function deriveSessionId() {
  const date = new Date().toISOString().slice(0, 10);
  const entropy = crypto.randomBytes(4).toString('hex');
  return `qa-${date}-${entropy}`;
}

/**
 * Resolve a stable session-id for a run.
 *
 * Precedence: an explicit `sessionId` option wins; otherwise the
 * `QA_SESSION_ID` environment variable; otherwise a freshly derived id. An
 * explicit or environment id is slugified so it is safe to use as a filename.
 *
 * @param {{ sessionId?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
export function resolveSessionId(opts = {}) {
  const explicit = opts.sessionId;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return slugifySessionId(explicit);
  }
  const fromEnv = (opts.env ?? process.env).QA_SESSION_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return slugifySessionId(fromEnv);
  }
  return deriveSessionId();
}

/**
 * The ledger path for a session: `<tempRoot>/qa/<sessionId>.ndjson`.
 *
 * @param {string} sessionId A slug-safe session-id (see {@link resolveSessionId}).
 * @param {object} [config] Resolved config bag (for `project.paths.tempRoot`).
 * @returns {string}
 */
export function ledgerPathFor(sessionId, config) {
  const slug = slugifySessionId(sessionId);
  return path.join(tempRootFrom(config), QA_LEDGER_DIRNAME, `${slug}.ndjson`);
}

/**
 * Parse a single ndjson line into a ledger item, or `null` when the line is
 * blank or not valid JSON. Malformed lines are skipped rather than thrown so a
 * partially-written ledger from a crashed run still resumes.
 *
 * @param {string} line
 * @returns {object | null}
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Read and parse an existing ledger from disk.
 *
 * Returns the full parsed `items` array plus `untriaged` — the subset whose
 * disposition is not yet triaged (the rolling backlog). A missing ledger is
 * not an error: it yields empty arrays and `exists: false`.
 *
 * @param {string} ledgerPath
 * @param {{ fsImpl?: typeof fs }} [opts]
 * @returns {{ exists: boolean, items: object[], untriaged: object[] }}
 */
export function readLedger(ledgerPath, opts = {}) {
  const fsImpl = opts.fsImpl ?? fs;
  if (!fsImpl.existsSync(ledgerPath)) {
    return { exists: false, items: [], untriaged: [] };
  }
  const raw = fsImpl.readFileSync(ledgerPath, 'utf8');
  const items = raw.split('\n').map(parseLine).filter(Boolean);
  return { exists: true, items, untriaged: items.filter(isUntriaged) };
}

/**
 * Resolve a QA exploratory session: a stable session-id, the ledger path
 * under `<tempRoot>/qa/`, and the current ledger contents (parsed items plus
 * the un-triaged rolling backlog).
 *
 * `reused` is `true` when a ledger already exists for this session-id — the
 * signal that a resume run must append to, not overwrite, the file.
 *
 * @param {{
 *   sessionId?: string,
 *   config?: object,
 *   env?: NodeJS.ProcessEnv,
 *   fsImpl?: typeof fs,
 * }} [opts]
 * @returns {{
 *   sessionId: string,
 *   ledgerPath: string,
 *   reused: boolean,
 *   items: object[],
 *   untriaged: object[],
 * }}
 */
export function resolveQaSession(opts = {}) {
  const sessionId = resolveSessionId({
    sessionId: opts.sessionId,
    env: opts.env,
  });
  const ledgerPath = ledgerPathFor(sessionId, opts.config);
  const { exists, items, untriaged } = readLedger(ledgerPath, {
    fsImpl: opts.fsImpl,
  });
  return { sessionId, ledgerPath, reused: exists, items, untriaged };
}
