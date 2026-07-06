// .agents/scripts/lib/__tests__/config-settings-schema-delivery-ci.test.js
/**
 * Unit tests for the `delivery.ci.*` config namespace — Story #4356
 * (Epic #4355).
 *
 * Covers the binding acceptance contract:
 *   1. A config object setting every delivery.ci.* key resolves through the
 *      runtime AJV validator with no error.
 *   2. An unknown key under delivery.ci is rejected by the runtime validator.
 *   3. With delivery.ci unset, getCiDelivery yields earlyPr=true and
 *      autoMerge="trust-ci".
 *   4. delivery.ci.autoMerge accepts only "trust-ci" and "strict".
 *
 * The runtime schema is exercised through the same Ajv instance the resolver
 * compiles (AGENTRC_SCHEMA), so these assertions bind the actual validation
 * path — not a mirror.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CI_DELIVERY_DEFAULTS, getCiDelivery } from '../config/ci.js';
import { getAgentrcValidator } from '../config-settings-schema.js';

// Bind the actual resolver validation path (the same compiled Ajv instance
// config-resolver.js uses), not a re-compiled mirror.
function makeValidator() {
  return getAgentrcValidator();
}

// Minimal top-level skeleton so `project` (the only top-level required key)
// satisfies the schema; each case supplies its own `delivery.ci` block.
const PROJECT_SKELETON = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
};

function withCi(ci) {
  return { project: PROJECT_SKELETON, delivery: { ci } };
}

describe('delivery.ci.* runtime AJV schema (Story #4356)', () => {
  it('accepts a fully-populated delivery.ci block', () => {
    const validate = makeValidator();
    const ok = validate(
      withCi({
        earlyPr: false,
        watch: { pollIntervalMs: 15000, maxPolls: 200, maxResumes: 5 },
        autoMerge: 'strict',
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts the reference default shape', () => {
    const validate = makeValidator();
    const ok = validate(
      withCi({
        skipForStoryPushes: true,
        earlyPr: true,
        watch: { pollIntervalMs: 30000, maxPolls: 120, maxResumes: 3 },
        autoMerge: 'trust-ci',
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects an unknown key under delivery.ci', () => {
    const validate = makeValidator();
    const ok = validate(withCi({ bogus: true }));
    assert.equal(ok, false);
    assert.ok(
      validate.errors.some((e) => e.keyword === 'additionalProperties'),
      'expected an additionalProperties violation',
    );
  });

  it('rejects an unknown key under delivery.ci.watch', () => {
    const validate = makeValidator();
    const ok = validate(withCi({ watch: { bogus: 1 } }));
    assert.equal(ok, false);
    assert.ok(
      validate.errors.some((e) => e.keyword === 'additionalProperties'),
      'expected an additionalProperties violation on watch',
    );
  });

  it('rejects an autoMerge value outside the enum', () => {
    const validate = makeValidator();
    const ok = validate(withCi({ autoMerge: 'yolo' }));
    assert.equal(ok, false);
    assert.ok(
      validate.errors.some((e) => e.keyword === 'enum'),
      'expected an enum violation on autoMerge',
    );
  });

  it('accepts both enum values for autoMerge', () => {
    const validate = makeValidator();
    for (const autoMerge of ['trust-ci', 'strict']) {
      const ok = validate(withCi({ autoMerge }));
      assert.equal(
        ok,
        true,
        `${autoMerge}: ${JSON.stringify(validate.errors)}`,
      );
    }
  });

  it('rejects a non-integer watch.pollIntervalMs', () => {
    const validate = makeValidator();
    const ok = validate(withCi({ watch: { pollIntervalMs: 1.5 } }));
    assert.equal(ok, false);
  });
});

describe('getCiDelivery defaults (Story #4356)', () => {
  it('yields earlyPr=true and autoMerge="trust-ci" when delivery.ci is unset', () => {
    const resolved = getCiDelivery({});
    assert.equal(resolved.earlyPr, true);
    assert.equal(resolved.autoMerge, 'trust-ci');
    assert.equal(resolved.skipForStoryPushes, true);
  });

  it('mirrors the frozen default constants', () => {
    assert.equal(CI_DELIVERY_DEFAULTS.earlyPr, true);
    assert.equal(CI_DELIVERY_DEFAULTS.autoMerge, 'trust-ci');
  });

  it('passes through operator overrides', () => {
    const resolved = getCiDelivery({
      delivery: {
        ci: {
          earlyPr: false,
          autoMerge: 'strict',
          watch: { pollIntervalMs: 5000 },
        },
      },
    });
    assert.equal(resolved.earlyPr, false);
    assert.equal(resolved.autoMerge, 'strict');
    assert.deepEqual(resolved.watch, { pollIntervalMs: 5000 });
  });

  it('falls back to trust-ci for an invalid autoMerge value', () => {
    const resolved = getCiDelivery({ delivery: { ci: { autoMerge: 'nope' } } });
    assert.equal(resolved.autoMerge, 'trust-ci');
  });
});
