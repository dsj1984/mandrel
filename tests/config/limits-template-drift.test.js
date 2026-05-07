import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMITS_DEFAULTS } from '../../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Story #1002 / Task #1015 — drift guard between
// `.agents/default-agentrc.json` (`agentSettings.limits`) and
// `LIMITS_DEFAULTS` from `.agents/scripts/lib/config/limits.js`.
//
// Operators bootstrap their `.agentrc.json` from the distributed template, so
// the template's `agentSettings.limits` MUST deep-equal the runtime defaults
// the framework would otherwise resolve. Any divergence makes consumer
// behaviour depend on whether they copied the template wholesale (bigger
// numbers win) or merged it on top of their own block (defaults win).
// ---------------------------------------------------------------------------

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../.agents/default-agentrc.json', import.meta.url),
);

/**
 * Strip `Object.freeze` so deep-equal compares value shape, not identity.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function unfreeze(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Diff two plain objects key-by-key, descending into nested objects as far
 * as needed. Originally a one-level diff scoped to `friction` /
 * `planningContext`; Epic #1030 Story #1039 introduced the two-level
 * `signals.<detector>.<key>` block so the helper now walks the tree.
 * Arrays compare via JSON-stringification (deep value equality, no
 * identity sensitivity).
 *
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} prefix
 * @param {Set<string>} [diffs]
 * @returns {string[]}
 */
function divergentKeys(expected, actual, prefix = '', diffs = new Set()) {
  const expIsObj =
    expected !== null &&
    typeof expected === 'object' &&
    !Array.isArray(expected);
  const actIsObj =
    actual !== null && typeof actual === 'object' && !Array.isArray(actual);
  if (expIsObj && actIsObj) {
    const keys = new Set([
      ...Object.keys(/** @type {object} */ (expected)),
      ...Object.keys(/** @type {object} */ (actual)),
    ]);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      divergentKeys(
        /** @type {Record<string, unknown>} */ (expected)[key],
        /** @type {Record<string, unknown>} */ (actual)[key],
        path,
        diffs,
      );
    }
    return prefix === '' ? [...diffs].sort() : [];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      diffs.add(prefix);
    }
  } else if (expected !== actual) {
    diffs.add(prefix);
  }
  return prefix === '' ? [...diffs].sort() : [];
}

describe('default-agentrc.json agentSettings.limits ↔ LIMITS_DEFAULTS', () => {
  const raw = readFileSync(TEMPLATE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const templateLimits = parsed?.agentSettings?.limits;

  it('template ships an agentSettings.limits block', () => {
    assert.ok(
      templateLimits && typeof templateLimits === 'object',
      'default-agentrc.json must define agentSettings.limits as an object',
    );
  });

  it('every LIMITS_DEFAULTS key appears in the template', () => {
    const expected = unfreeze(LIMITS_DEFAULTS);
    const missing = Object.keys(expected).filter(
      (k) => !(k in /** @type {object} */ (templateLimits)),
    );
    assert.deepEqual(
      missing,
      [],
      `template is missing limit keys: ${missing.join(', ')}`,
    );
  });

  it('template deep-equals LIMITS_DEFAULTS (no maxTickets / friction / planningContext drift)', () => {
    const expected = unfreeze(LIMITS_DEFAULTS);
    const diverged = divergentKeys(expected, templateLimits);
    assert.deepEqual(
      diverged,
      [],
      `default-agentrc.json agentSettings.limits drifted from LIMITS_DEFAULTS at: ${diverged.join(', ')}. Update .agents/default-agentrc.json or .agents/scripts/lib/config/limits.js so both sides agree.`,
    );
    assert.deepEqual(templateLimits, expected);
  });
});
