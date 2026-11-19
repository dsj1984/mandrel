// lib/cli/ui/request-guard.js
/**
 * The `mandrel ui` request checks: the Host allowlist, the per-process
 * token, the POST origin and content type, and strict validation of an
 * action body. Pure; the server answers 403 or 400 from what these return.
 *
 * @module cli/ui/request-guard
 */

import { timingSafeEqual } from 'node:crypto';

import {
  DEFAULT_DONE_LIMIT,
  DONE_LIMITS,
} from '../../../.agents/scripts/lib/dispatch/status.js';

/** A POST body larger than this is refused unread. */
export const MAX_BODY_BYTES = 4096;

/** `delivery.environments` key pattern, as `agentrc.schema.json` declares it. */
const ENV_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const ACTIONS = new Set(['dispatch', 'resume', 'stop']);
const BODY_KEYS = new Set(['action', 'storyId', 'environment']);

/**
 * @param {string|undefined} host The request's `Host` header.
 * @param {number} port The port the server is bound to.
 * @returns {boolean}
 */
export function isAllowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Constant-time token comparison; a missing or differently sized value is
 * refused without comparing.
 *
 * @param {unknown} presented
 * @param {string} expected
 * @returns {boolean}
 */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A POST must come from the page this server served, as JSON.
 *
 * @param {{ origin?: string, 'content-type'?: string, host?: string }} headers
 * @returns {boolean}
 */
export function isSameOriginJson(headers) {
  const mediaType = String(headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return (
    mediaType === 'application/json' &&
    headers.origin === `http://${headers.host}`
  );
}

/**
 * Validate a parsed action body against the configured environment names.
 *
 * @param {unknown} body
 * @param {string[]} environmentNames
 * @returns {{ ok: true, value: { action: string, storyId: number, environment: string } }
 *   | { ok: false, error: string }}
 */
export function validateAction(body, environmentNames) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid-body' };
  }
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) {
    return { ok: false, error: 'unknown-property' };
  }
  const { action, storyId, environment } = body;
  if (!ACTIONS.has(action)) return { ok: false, error: 'invalid-action' };
  if (!Number.isInteger(storyId) || storyId < 1) {
    return { ok: false, error: 'invalid-story-id' };
  }
  if (
    typeof environment !== 'string' ||
    !ENV_NAME_RE.test(environment) ||
    !environmentNames.includes(environment)
  ) {
    return { ok: false, error: 'invalid-environment' };
  }
  return { ok: true, value: { action, storyId, environment } };
}

/**
 * The `done` query parameter: the default when absent, `null` when it is
 * not one of `dispatch --done-limit`'s values.
 *
 * @param {string} url
 * @returns {number|null}
 */
export function doneLimitFrom(url) {
  const raw = new URL(url, 'http://localhost').searchParams.get('done');
  if (raw === null) return DEFAULT_DONE_LIMIT;
  return DONE_LIMITS.map(String).includes(raw) ? Number(raw) : null;
}
