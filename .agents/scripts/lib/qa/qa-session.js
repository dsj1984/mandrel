/**
 * QA exploratory-session resume helper. A resumed run with the same
 * session-id reads the on-disk NDJSON ledger, carries forward un-triaged items
 * as the rolling backlog, and appends — never overwrites. Items round-trip
 * untouched so optional fields (e.g. `routedTo`) survive. Evidence must be
 * redacted before it reaches the ledger; this module only reads.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { tempRootFrom } from '../config/temp-paths.js';

const QA_LEDGER_DIRNAME = 'qa';

/**
 * Mirrors the `disposition` enum in `qa-ledger.schema.json`; anything else
 * (absent, null, unrecognized) is still backlog.
 */
export const TRIAGED_DISPOSITIONS = Object.freeze(['file', 'defer', 'dismiss']);

/**
 * @param {{ disposition?: unknown }} item
 * @returns {boolean}
 */
export function isUntriaged(item) {
  const disposition = item?.disposition;
  return !TRIAGED_DISPOSITIONS.includes(disposition);
}

/**
 * Filesystem-safe slug; guards against a hostile label escaping `qa/`.
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
 * Date-prefixed with short entropy so same-day runs never collide.
 *
 * @returns {string}
 */
function deriveSessionId() {
  const date = new Date().toISOString().slice(0, 10);
  const entropy = crypto.randomBytes(4).toString('hex');
  return `qa-${date}-${entropy}`;
}

/**
 * Explicit `sessionId`, then `QA_SESSION_ID`, then a derived id.
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
 * @param {string} sessionId
 * @param {object} [config]
 * @returns {string} `<tempRoot>/qa/<sessionId>.ndjson`
 */
export function ledgerPathFor(sessionId, config) {
  const slug = slugifySessionId(sessionId);
  return path.join(tempRootFrom(config), QA_LEDGER_DIRNAME, `${slug}.ndjson`);
}

/**
 * Malformed lines are skipped so a crashed run's partial ledger still resumes.
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
 * `reused: true` means a ledger exists and the run must append to it.
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
