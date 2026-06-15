// tests/navigability-config-schema.test.js
//
// Contract test for the Epic #4131 navigability config keys against the
// RUNTIME AJV validator (the gate `config-resolver` applies on load), not just
// the published JSON-Schema mirror. The Epic #4131 audit found that the
// configured path was dead-on-arrival: the published mirror carried
// `planning.navigation` but the runtime `PLANNING_SCHEMA` /
// `QUALITY_SCHEMA` (both `additionalProperties: false`) did not, so a consumer
// who actually set the documented keys had their entire `.agentrc.json`
// rejected. These tests exercise the configured (populated) path so that
// regression is visible to CI — the original Story tests only ever stubbed the
// resolver and never round-tripped a populated block through the real gate.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAgentrcValidator } from '../.agents/scripts/lib/config-settings-schema.js';

/** Minimal valid `project` block so the only thing under test is the nav keys. */
const PROJECT = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
};

describe('navigability config — runtime AJV validator accepts the configured path', () => {
  it('accepts a populated planning.navigation block (F7 reachability check)', () => {
    const validate = getAgentrcValidator();
    const ok = validate({
      project: PROJECT,
      planning: {
        navigation: {
          routeGlobs: ['pages/**', 'app/**/route.ts'],
          navRegistry: ['src/nav.ts'],
        },
      },
    });
    assert.equal(
      ok,
      true,
      `planning.navigation must validate; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it('accepts a populated delivery.quality.navigability block (F2/F3/F1/F4)', () => {
    const validate = getAgentrcValidator();
    const ok = validate({
      project: PROJECT,
      delivery: {
        quality: {
          navigability: {
            routeGlobs: ['pages/**'],
            navRegistry: ['src/nav.ts'],
            journeySuite: 'npm run journeys',
          },
        },
      },
    });
    assert.equal(
      ok,
      true,
      `delivery.quality.navigability must validate; errors: ${JSON.stringify(validate.errors)}`,
    );
  });

  it('still rejects an unknown subkey under planning.navigation (additionalProperties)', () => {
    const validate = getAgentrcValidator();
    const ok = validate({
      project: PROJECT,
      planning: { navigation: { bogusKey: true } },
    });
    assert.equal(ok, false, 'unknown navigation subkey must be rejected');
  });

  it('still rejects an unknown subkey under delivery.quality.navigability', () => {
    const validate = getAgentrcValidator();
    const ok = validate({
      project: PROJECT,
      delivery: { quality: { navigability: { bogusKey: true } } },
    });
    assert.equal(ok, false, 'unknown navigability subkey must be rejected');
  });
});
