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
 * Diff two plain objects key-by-key (one level deep is enough for the
 * `limits` block — `friction` and `planningContext` are the only nested
 * bags). Returns a sorted list of `topKey` / `topKey.nestedKey` paths that
 * differ.
 * @param {Record<string, unknown>} expected
 * @param {Record<string, unknown>} actual
 * @returns {string[]}
 */
function divergentKeys(expected, actual) {
  const diffs = new Set();
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    const exp = expected[key];
    const act = actual[key];
    const expIsObj =
      exp !== null && typeof exp === 'object' && !Array.isArray(exp);
    const actIsObj =
      act !== null && typeof act === 'object' && !Array.isArray(act);
    if (expIsObj && actIsObj) {
      const nestedKeys = new Set([
        ...Object.keys(/** @type {object} */ (exp)),
        ...Object.keys(/** @type {object} */ (act)),
      ]);
      for (const nk of nestedKeys) {
        if (
          /** @type {Record<string, unknown>} */ (exp)[nk] !==
          /** @type {Record<string, unknown>} */ (act)[nk]
        ) {
          diffs.add(`${key}.${nk}`);
        }
      }
    } else if (exp !== act) {
      diffs.add(key);
    }
  }
  return [...diffs].sort();
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
