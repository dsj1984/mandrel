import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LIMITS_DEFAULTS,
  resolveLimits,
  resolvePreflightCeilings,
} from '../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Story #3875 — size Stories against the real delivery envelope.
//
// The global hydration budget (`delivery.maxTokenBudget`) is raised once
// from 200000 to 300000 as a SINGLE global value: there is no per-profile
// or per-complexity conditional budget branch anywhere in the resolver.
// `resolvePreflightCeilings` exposes the configured (non-null)
// `delivery.preflight.max*` ceilings so the decomposition context can
// thread them to the planner.
// ---------------------------------------------------------------------------

const LIMITS_SOURCE_PATH = fileURLToPath(
  new URL('../.agents/scripts/lib/config/limits.js', import.meta.url),
);

describe('delivery.maxTokenBudget global value (Story #3875)', () => {
  it('defaults to 300000 in LIMITS_DEFAULTS', () => {
    assert.equal(LIMITS_DEFAULTS.maxTokenBudget, 300000);
  });

  it('resolves to 300000 when the config omits delivery.maxTokenBudget', () => {
    assert.equal(resolveLimits({}).maxTokenBudget, 300000);
    assert.equal(resolveLimits(undefined).maxTokenBudget, 300000);
  });

  it('still honors an explicit operator override', () => {
    const lim = resolveLimits({ delivery: { maxTokenBudget: 12345 } });
    assert.equal(lim.maxTokenBudget, 12345);
  });

  it('has no profile-conditional budget branch in the resolver source', () => {
    const source = readFileSync(LIMITS_SOURCE_PATH, 'utf8');
    // The budget MUST stay a single global value. A profile- or
    // complexity-keyed branch (e.g. `profiles: { fast: ... }` or
    // `complexity::`-keyed lookups) would reintroduce the per-shape
    // budget split this Story removed by design.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(
      code,
      /profile/i,
      'limits.js must not contain profile-conditional budget code',
    );
    assert.doesNotMatch(
      code,
      /complexity/i,
      'limits.js must not key the budget off a complexity profile',
    );
  });
});

describe('resolvePreflightCeilings (Story #3875)', () => {
  it('returns only the configured delivery.preflight.max* keys', () => {
    const ceilings = resolvePreflightCeilings({
      delivery: {
        preflight: { maxStories: 12, maxClaudeQuotaTokens: 5000000 },
      },
    });
    assert.deepEqual(ceilings, {
      maxStories: 12,
      maxClaudeQuotaTokens: 5000000,
    });
  });

  it('omits null floors ("no cap") entirely', () => {
    const ceilings = resolvePreflightCeilings({
      delivery: { preflight: { maxStories: 3, maxWaves: null } },
    });
    assert.deepEqual(ceilings, { maxStories: 3 });
  });

  it('returns an empty object (not null) when delivery.preflight is absent', () => {
    assert.deepEqual(resolvePreflightCeilings({}), {});
    assert.deepEqual(resolvePreflightCeilings(undefined), {});
    assert.deepEqual(resolvePreflightCeilings({ delivery: {} }), {});
  });
});
