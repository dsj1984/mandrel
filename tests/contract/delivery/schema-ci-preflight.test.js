// tests/contract/delivery/schema-ci-preflight.test.js
/**
 * Contract test — Story #2899 Task #2926 (Epic #2880, F13) + Story #4356.
 *
 * The AJV `.agentrc.json` schema MUST accept the surviving `delivery.ci`
 * knobs (`watch`, `autoMerge`). Retired: `skipForStoryPushes`, `earlyPr`,
 * `requireChecks`, and the entire `delivery.preflight` block.
 *
 * The starter delta-seed (`.agents/starter-agentrc.json`) no longer carries
 * a delivery.ci block — CI defaults come from getCiDelivery.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CI_DELIVERY_DEFAULTS,
  getCiDelivery,
} from '../../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const STARTER_PATH = path.join(REPO_ROOT, '.agents/starter-agentrc.json');

const MINIMAL_PROJECT = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
};

describe('contract/delivery/schema-ci-preflight', () => {
  describe('AJV schema acceptance', () => {
    it('accepts delivery.ci.autoMerge: strict', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: MINIMAL_PROJECT,
        delivery: { ci: { autoMerge: 'strict' } },
      };
      const ok = validate(doc);
      assert.equal(ok, true, JSON.stringify(validate.errors));
    });

    it('rejects the folded delivery.ci.watch poll-loop tuning (Story #5382)', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: MINIMAL_PROJECT,
        delivery: {
          ci: {
            watch: { pollIntervalMs: 5000, maxPolls: 60, maxResumes: 2 },
          },
        },
      };
      assert.equal(validate(doc), false);
      assert.ok(
        validate.errors.some((e) => e.params?.additionalProperty === 'watch'),
        JSON.stringify(validate.errors),
      );
    });

    it('rejects retired delivery.ci.skipForStoryPushes', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: MINIMAL_PROJECT,
        delivery: { ci: { skipForStoryPushes: false } },
      };
      const ok = validate(doc);
      assert.equal(ok, false);
    });

    it('rejects retired delivery.ci.earlyPr', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: MINIMAL_PROJECT,
        delivery: { ci: { earlyPr: false } },
      };
      const ok = validate(doc);
      assert.equal(ok, false);
    });

    it('rejects retired delivery.ci.requireChecks', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: MINIMAL_PROJECT,
        delivery: { ci: { requireChecks: true } },
      };
      const ok = validate(doc);
      assert.equal(ok, false);
    });

    it('rejects retired delivery.preflight.maxStories', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: MINIMAL_PROJECT,
        delivery: { preflight: { maxStories: 100 } },
      };
      const ok = validate(doc);
      assert.equal(ok, false);
    });

    it('rejects an unknown delivery.ci.* key (additionalProperties:false)', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: MINIMAL_PROJECT,
        delivery: { ci: { skipForBackport: true } },
      };
      const ok = validate(doc);
      assert.equal(ok, false);
    });
  });

  describe('starter-agentrc.json default', () => {
    it('does not ship the retired delivery.ci.skipForStoryPushes key', () => {
      const raw = JSON.parse(readFileSync(STARTER_PATH, 'utf8'));
      assert.equal(raw.delivery?.ci?.skipForStoryPushes, undefined);
    });
  });

  describe('config accessors', () => {
    it('getCiDelivery returns the framework defaults when the block is omitted', () => {
      const merged = getCiDelivery({ delivery: {} });
      assert.equal(merged.autoMerge, CI_DELIVERY_DEFAULTS.autoMerge);
      assert.equal(merged.watch, undefined);
      assert.equal('skipForStoryPushes' in merged, false);
      assert.equal('earlyPr' in merged, false);
      assert.equal('requireChecks' in merged, false);
      // Story #5096 — the advisory-gate knobs default ON with an empty
      // allowlist, so an unconfigured consumer is protected by default.
      assert.equal(
        merged.blockOnAdvisoryFailure,
        CI_DELIVERY_DEFAULTS.blockOnAdvisoryFailure,
      );
      assert.equal(merged.blockOnAdvisoryFailure, true);
      assert.deepEqual(merged.advisoryAllowlist, []);
    });

    it('getCiDelivery honors explicit advisory-gate overrides (Story #5096)', () => {
      const merged = getCiDelivery({
        delivery: {
          ci: {
            blockOnAdvisoryFailure: false,
            advisoryAllowlist: ['Bundle-size ratchet'],
          },
        },
      });
      assert.equal(merged.blockOnAdvisoryFailure, false);
      assert.deepEqual(merged.advisoryAllowlist, ['Bundle-size ratchet']);
    });

    it('getCiDelivery coerces a malformed advisory-gate block to the defaults (Story #5096)', () => {
      const merged = getCiDelivery({
        delivery: {
          ci: { blockOnAdvisoryFailure: 'yes', advisoryAllowlist: 'nope' },
        },
      });
      // A non-boolean is not "false" — it is absent, so the protective
      // default stands rather than being silently disabled by a typo.
      assert.equal(merged.blockOnAdvisoryFailure, true);
      assert.deepEqual(merged.advisoryAllowlist, []);
    });

    it('getCiDelivery honors an explicit autoMerge strict override', () => {
      const merged = getCiDelivery({
        delivery: { ci: { autoMerge: 'strict' } },
      });
      assert.equal(merged.autoMerge, 'strict');
    });

    it('getCiDelivery no longer surfaces delivery.ci.watch (Story #5382)', () => {
      const merged = getCiDelivery({
        delivery: { ci: { watch: { maxPolls: 42 } } },
      });
      assert.equal('watch' in merged, false);
    });
  });
});
