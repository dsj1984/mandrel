// tests/contract/delivery/schema-ci-preflight.test.js
/**
 * Contract test — Story #2899 Task #2926 (Epic #2880, F13) + Story #4356.
 *
 * The AJV `.agentrc.json` schema MUST accept the delivery.preflight and
 * delivery.ci blocks. `delivery.ci.skipForStoryPushes` was retired; the
 * surviving ci knobs are earlyPr / watch / autoMerge / requireChecks.
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
  getPreflight,
  PREFLIGHT_DEFAULTS,
} from '../../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const STARTER_PATH = path.join(REPO_ROOT, '.agents/starter-agentrc.json');

describe('contract/delivery/schema-ci-preflight', () => {
  describe('AJV schema acceptance', () => {
    it('accepts delivery.ci.earlyPr: false', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: { ci: { earlyPr: false } },
      };
      const ok = validate(doc);
      assert.equal(ok, true, JSON.stringify(validate.errors));
    });

    it('rejects retired delivery.ci.skipForStoryPushes', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: { ci: { skipForStoryPushes: false } },
      };
      const ok = validate(doc);
      assert.equal(ok, false);
    });

    it('accepts delivery.preflight.maxStories: 100', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: { preflight: { maxStories: 100 } },
      };
      const ok = validate(doc);
      assert.equal(ok, true, JSON.stringify(validate.errors));
    });

    it('accepts a combined delivery.ci + delivery.preflight document', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: {
          ci: { earlyPr: false, autoMerge: 'strict' },
          preflight: {
            maxStories: 100,
            maxWaves: 5,
            maxInstallCostSeconds: 300,
            maxGithubApiRequests: 2000,
            maxClaudeQuotaTokens: 1000000,
          },
        },
      };
      const ok = validate(doc);
      assert.equal(ok, true, JSON.stringify(validate.errors));
    });

    it('rejects an unknown delivery.ci.* key (additionalProperties:false)', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: { ci: { skipForBackport: true } },
      };
      const ok = validate(doc);
      assert.equal(ok, false);
    });

    it('rejects delivery.preflight.maxStories below 1', () => {
      const validate = getAgentrcValidator();
      const doc = {
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: { preflight: { maxStories: 0 } },
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
      assert.equal(merged.earlyPr, CI_DELIVERY_DEFAULTS.earlyPr);
      assert.equal(merged.autoMerge, CI_DELIVERY_DEFAULTS.autoMerge);
      assert.equal(merged.requireChecks, CI_DELIVERY_DEFAULTS.requireChecks);
      assert.equal('skipForStoryPushes' in merged, false);
    });

    it('getCiDelivery honors an explicit earlyPr false override', () => {
      const merged = getCiDelivery({
        delivery: { ci: { earlyPr: false } },
      });
      assert.equal(merged.earlyPr, false);
    });

    it('getPreflight returns null floors when the block is omitted', () => {
      const merged = getPreflight({ delivery: {} });
      assert.deepEqual(merged, PREFLIGHT_DEFAULTS);
    });

    it('getPreflight passes through operator integer thresholds', () => {
      const merged = getPreflight({
        delivery: { preflight: { maxStories: 42 } },
      });
      assert.equal(merged.maxStories, 42);
    });

    it('getPreflight rejects a non-integer floor and falls back to default', () => {
      const merged = getPreflight({
        delivery: { preflight: { maxStories: 'bad' } },
      });
      assert.equal(merged.maxStories, PREFLIGHT_DEFAULTS.maxStories);
    });
  });
});
