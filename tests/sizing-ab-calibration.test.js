/**
 * sizing-ab-calibration.test.js — A/B re-plan calibration proof (Story #3877).
 *
 * Contract tier. Re-plans one delivered Epic body
 * (tests/fixtures/sizing-ab/, the model-evolution recalibration Epic #3865)
 * under the OLD and NEW Story-sizing constant profiles and asserts the new
 * profile yields strictly fewer Stories at higher mean files/Story, with every
 * new-profile Story inside the new ceilings. This is the empirical evidence
 * that the relaxed `DEFAULT_TASK_SIZING` shipped by Story #3874 is a genuine
 * recalibration — wide capabilities fold into fewer Stories rather than being
 * sharded apart by the old `softFiles=5 / hardFiles=15` profile.
 *
 * The fixture is scored through the live `computeSizingFindings` from the SSOT
 * sizing module so the proof exercises the real validator surface, not a
 * re-implementation, and so any future calibration tuning of the constants
 * keeps this test honest.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeSizingFindings,
  DEFAULT_TASK_SIZING,
} from '../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'sizing-ab');

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf-8'));
}

const oldPlan = loadJson('plan.old.json');
const newPlan = loadJson('plan.new.json');
const profiles = loadJson('profiles.json');

/** Total entries (a path may be touched by more than one Story). */
function changeEntryCount(plan) {
  return plan.stories.reduce(
    (sum, story) => sum + story.body.changes.length,
    0,
  );
}

/** Unique union of files the plan delivers. */
function fileUnion(plan) {
  const union = new Set();
  for (const story of plan.stories) {
    for (const change of story.body.changes) union.add(change.path);
  }
  return union;
}

function meanFilesPerStory(plan) {
  return changeEntryCount(plan) / plan.stories.length;
}

/** Hard `oversized-task` findings the given sizing profile would raise. */
function hardOversizedFindings(plan, sizing) {
  return computeSizingFindings({ stories: plan.stories, sizing }).filter(
    (finding) =>
      finding.kind === 'oversized-task' && finding.severity === 'hard',
  );
}

describe('sizing A/B re-plan calibration (Story #3877)', () => {
  it('both plans deliver the identical union of delivered files', () => {
    const oldUnion = fileUnion(oldPlan);
    const newUnion = fileUnion(newPlan);
    assert.equal(
      oldUnion.size,
      newUnion.size,
      'old and new plans must deliver the same number of unique files',
    );
    for (const file of oldUnion) {
      assert.ok(
        newUnion.has(file),
        `file "${file}" delivered by the old plan is missing from the new plan`,
      );
    }
    assert.equal(
      oldUnion.size,
      profiles.totalFiles,
      'recorded totalFiles must match the delivered union',
    );
  });

  it('the new profile yields strictly fewer Stories than the old profile', () => {
    assert.ok(
      newPlan.stories.length < oldPlan.stories.length,
      `new plan (${newPlan.stories.length} Stories) must be strictly fewer than old plan (${oldPlan.stories.length} Stories)`,
    );
  });

  it('the new profile yields strictly higher mean files/Story', () => {
    const oldMean = meanFilesPerStory(oldPlan);
    const newMean = meanFilesPerStory(newPlan);
    assert.ok(
      newMean > oldMean,
      `new mean files/Story (${newMean.toFixed(2)}) must exceed old mean (${oldMean.toFixed(2)})`,
    );
  });

  it('every new-profile Story is within the new ceilings (no hard finding)', () => {
    const findings = hardOversizedFindings(newPlan, profiles.new);
    assert.deepEqual(
      findings,
      [],
      `new-profile Stories must not trip any hard sizing finding under the new profile; got ${JSON.stringify(findings)}`,
    );
  });

  it('the old plan would NOT have fit the new slicing under the OLD profile', () => {
    // The fragmentation is genuine, not a relabeling: re-score the NEW plan's
    // wide Stories against the OLD profile and prove at least one trips the
    // old hard ceiling — i.e. the old profile could not have accepted the
    // wider new slicing and was forced to shard the work apart.
    const findings = hardOversizedFindings(newPlan, profiles.old);
    assert.ok(
      findings.length > 0,
      'at least one new-profile (wide) Story must exceed the OLD hardFiles ceiling, proving the old profile forced finer slicing',
    );
    for (const finding of findings) {
      assert.equal(finding.field, 'fileCount');
      assert.equal(finding.ceiling, profiles.old.hardFiles);
    }
  });

  it('the old plan itself stays within the OLD ceilings (a valid old-profile plan)', () => {
    const findings = hardOversizedFindings(oldPlan, profiles.old);
    assert.deepEqual(
      findings,
      [],
      `old-profile Stories must each fit the old ceilings; got ${JSON.stringify(findings)}`,
    );
  });

  it('the recorded new profile stays in lockstep with DEFAULT_TASK_SIZING', () => {
    // Drift gate: if a future calibration tunes the live constants, this
    // fixture must be updated in the same change so the A/B proof stays valid.
    assert.equal(profiles.new.softFiles, DEFAULT_TASK_SIZING.softFiles);
    assert.equal(
      profiles.new.softAcceptanceCount,
      DEFAULT_TASK_SIZING.softAcceptanceCount,
    );
    assert.equal(profiles.new.hardFiles, DEFAULT_TASK_SIZING.hardFiles);
    assert.equal(profiles.new.maxAcceptance, DEFAULT_TASK_SIZING.maxAcceptance);
  });
});
