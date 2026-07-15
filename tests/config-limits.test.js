import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LIMITS_DEFAULTS,
  resolveLimits,
} from '../.agents/scripts/lib/config/limits.js';

// ---------------------------------------------------------------------------
// Story #3875 — size Stories against session-mass ceilings, not a token-budget
// envelope. `maxTokenBudget` was retired; `resolveLimits` never exposes it.
// ---------------------------------------------------------------------------

const LIMITS_SOURCE_PATH = fileURLToPath(
  new URL('../.agents/scripts/lib/config/limits.js', import.meta.url),
);

describe('maxTokenBudget absent from LIMITS_DEFAULTS (Story #3875)', () => {
  it('is not declared on LIMITS_DEFAULTS', () => {
    assert.equal('maxTokenBudget' in LIMITS_DEFAULTS, false);
  });

  it('resolveLimits never returns maxTokenBudget', () => {
    assert.equal('maxTokenBudget' in resolveLimits({}), false);
    assert.equal('maxTokenBudget' in resolveLimits(undefined), false);
    assert.equal(
      'maxTokenBudget' in resolveLimits({ delivery: { maxTokenBudget: 12345 } }),
      false,
    );
  });

  it('has no profile-conditional budget branch in the resolver source', () => {
    const source = readFileSync(LIMITS_SOURCE_PATH, 'utf8');
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
