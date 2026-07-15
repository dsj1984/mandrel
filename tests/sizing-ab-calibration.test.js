/**
 * sizing-ab-calibration.test.js — capacity-model calibration proof (v2 Stage 2).
 *
 * Contract tier. Re-plans one delivered Epic body
 * (tests/fixtures/sizing-ab/, the model-evolution recalibration Epic #3865)
 * under the v2 model-capacity advisory and asserts every Story fits the
 * session-mass ceilings. Historical A/B file-ceiling proof (Story #3877)
 * is retained only as fixture shape — file/AC ceilings are retired.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeSizingFindings,
  DEFAULT_MODEL_CAPACITY,
  resolveCapacityCeilings,
} from '../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sizing-ab');

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf-8'));
}

const newPlan = loadJson('plan.new.json');
const profiles = loadJson('profiles.json');
const ceilings = resolveCapacityCeilings(DEFAULT_MODEL_CAPACITY);

/** Hard `oversized-task` findings under the live capacity profile. */
function hardOversizedFindings(plan) {
  return computeSizingFindings({
    stories: plan.stories,
    capacity: DEFAULT_MODEL_CAPACITY,
  }).filter(
    (finding) =>
      finding.kind === 'oversized-task' && finding.severity === 'hard',
  );
}

describe('sizing capacity calibration (v2 Stage 2)', () => {
  it('every new-profile Story fits the model-capacity ceilings (no hard finding)', () => {
    const findings = hardOversizedFindings(newPlan);
    assert.deepEqual(
      findings,
      [],
      `Stories must not trip any hard session-mass finding; got ${JSON.stringify(findings)}`,
    );
  });

  it('the recorded capacity profile stays in lockstep with DEFAULT_MODEL_CAPACITY', () => {
    // Drift gate: if a future calibration tunes the live constants, this
    // fixture must be updated in the same change.
    assert.equal(
      profiles.capacity.softSessionTokens,
      DEFAULT_MODEL_CAPACITY.softSessionTokens,
    );
    assert.equal(
      profiles.capacity.hardSessionTokens,
      DEFAULT_MODEL_CAPACITY.hardSessionTokens,
    );
    assert.equal(
      profiles.capacity.mergeCandidateMaxSessionTokens,
      DEFAULT_MODEL_CAPACITY.mergeCandidateMaxSessionTokens,
    );
    assert.equal(
      profiles.capacity.softSessionTokens,
      ceilings.softSessionTokens,
    );
    assert.equal(
      profiles.capacity.hardSessionTokens,
      ceilings.hardSessionTokens,
    );
  });

  it('retired file-ceiling and delivery-cost proxy knobs are absent', () => {
    assert.equal(DEFAULT_MODEL_CAPACITY.softFiles, undefined);
    assert.equal(DEFAULT_MODEL_CAPACITY.hardFiles, undefined);
    assert.equal(DEFAULT_MODEL_CAPACITY.softAcceptanceCount, undefined);
    assert.equal(DEFAULT_MODEL_CAPACITY.maxAcceptance, undefined);
    assert.equal(DEFAULT_MODEL_CAPACITY.tokensPerAcceptance, undefined);
    assert.equal(DEFAULT_MODEL_CAPACITY.tokensPerChange, undefined);
  });
});
