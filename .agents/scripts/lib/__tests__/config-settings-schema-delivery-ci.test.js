// .agents/scripts/lib/__tests__/config-settings-schema-delivery-ci.test.js
/**
 * Unit tests for the `delivery.ci.*` config namespace — Story #4356
 * (Epic #4355). `earlyPr` / `requireChecks` were retired on v2 (no
 * production readers); Story #5382 folded the never-set `watch.*` poll-loop
 * keys into `WATCH_DEFAULTS`. The surviving knobs are `autoMerge` and the
 * advisory-check policy.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CI_DELIVERY_DEFAULTS, getCiDelivery } from '../config/ci.js';
import { getAgentrcValidator } from '../config-settings-schema.js';

function makeValidator() {
  return getAgentrcValidator();
}

/**
 * Compile the shipped `.agentrc` mirror schema. `delivery.ci` is
 * `additionalProperties: false` on BOTH sides, so a key present in only one of
 * them is inert. Story #5382 pins the `watch` removal in both directions.
 */
function makeMirrorValidator() {
  const mirrorPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../schemas/agentrc.schema.json',
  );
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(mirrorPath, 'utf8')));
}

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
        autoMerge: 'strict',
        blockOnAdvisoryFailure: false,
        advisoryAllowlist: ['codeql'],
        rerunAdvisory: 1,
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('accepts the reference default shape', () => {
    const validate = makeValidator();
    const ok = validate(withCi({ autoMerge: 'trust-ci' }));
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

  it('rejects retired earlyPr / requireChecks keys', () => {
    const validate = makeValidator();
    assert.equal(validate(withCi({ earlyPr: false })), false);
    assert.equal(validate(withCi({ requireChecks: true })), false);
  });

  it('rejects the folded delivery.ci.watch block (Story #5382)', () => {
    const validate = makeValidator();
    const ok = validate(withCi({ watch: { pollIntervalMs: 10000 } }));
    assert.equal(ok, false);
    assert.ok(
      validate.errors.some((e) => e.params?.additionalProperty === 'watch'),
      'expected an additionalProperties violation naming watch',
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
});

describe('delivery.ci.watch.attachWindowMs (Story #4890 AC-4, folded by #5382)', () => {
  const runtime = makeValidator();
  const mirror = makeMirrorValidator();

  it('is rejected by the runtime AJV validator and the .agentrc mirror alike', () => {
    const config = withCi({ watch: { attachWindowMs: 1_200_000 } });
    assert.equal(runtime(config), false, 'runtime still accepts watch');
    assert.equal(mirror(config), false, 'mirror still accepts watch');
  });

  it('getCiDelivery no longer surfaces a watch block', () => {
    const resolved = getCiDelivery({
      delivery: { ci: { autoMerge: 'strict' } },
    });
    assert.equal('watch' in resolved, false);
  });
});

describe('getCiDelivery defaults (Story #4356)', () => {
  it('yields autoMerge="trust-ci" when delivery.ci is unset', () => {
    const resolved = getCiDelivery({});
    assert.equal(resolved.autoMerge, 'trust-ci');
    assert.equal('earlyPr' in resolved, false);
    assert.equal('requireChecks' in resolved, false);
  });

  it('mirrors the frozen default constants', () => {
    assert.equal(CI_DELIVERY_DEFAULTS.autoMerge, 'trust-ci');
    assert.equal(CI_DELIVERY_DEFAULTS.earlyPr, undefined);
    assert.equal(CI_DELIVERY_DEFAULTS.requireChecks, undefined);
  });

  it('passes through operator overrides', () => {
    const resolved = getCiDelivery({
      delivery: { ci: { autoMerge: 'strict' } },
    });
    assert.equal(resolved.autoMerge, 'strict');
  });

  it('falls back to trust-ci for an invalid autoMerge value', () => {
    const resolved = getCiDelivery({ delivery: { ci: { autoMerge: 'nope' } } });
    assert.equal(resolved.autoMerge, 'trust-ci');
  });
});
