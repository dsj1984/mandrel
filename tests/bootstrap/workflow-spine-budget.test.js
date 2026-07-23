/**
 * tests/bootstrap/workflow-spine-budget.test.js — lean-spine workflow budgets
 * (Story #4708, AC-4).
 *
 * The big workflow files ride resident for a whole session once invoked, so
 * each is split into a spine (happy path + gate list) with edge-case /
 * recovery / reference content in an on-demand appendix helper. This test is
 * the ratchet: each spine stays ≤ 8KB, and each keeps pointing at its
 * appendix so the moved content stays reachable.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** AC-4: each workflow spine must fit under 8KB. */
const SPINE_BUDGET_BYTES = 8 * 1024;

/** Spine → the on-demand appendix helper its detail moved into. */
const SPINES = [
  {
    spine: '.agents/workflows/plan.md',
    appendix: '.agents/workflows/helpers/plan-reference.md',
    appendixRef: 'helpers/plan-reference.md',
  },
  {
    spine: '.agents/workflows/deliver.md',
    appendix: '.agents/workflows/helpers/deliver-reference.md',
    appendixRef: 'helpers/deliver-reference.md',
  },
  {
    spine: '.agents/workflows/helpers/deliver-story.md',
    appendix: '.agents/workflows/helpers/deliver-story-reference.md',
    appendixRef: 'deliver-story-reference.md',
  },
];

describe('workflow spine budget (Story #4708, AC-4)', () => {
  for (const { spine, appendix, appendixRef } of SPINES) {
    it(`${spine} is ≤ ${SPINE_BUDGET_BYTES} bytes`, () => {
      const bytes = statSync(path.join(REPO_ROOT, spine)).size;
      assert.ok(
        bytes <= SPINE_BUDGET_BYTES,
        `${spine} is ${bytes} bytes, over the ${SPINE_BUDGET_BYTES}-byte spine budget — ` +
          `move edge-case/recovery/reference content into ${appendix} instead of growing the spine`,
      );
    });

    it(`${spine} points at its on-demand appendix`, () => {
      const spineText = readFileSync(path.join(REPO_ROOT, spine), 'utf8');
      assert.ok(
        spineText.includes(appendixRef),
        `${spine} no longer references ${appendixRef} — the moved detail must stay reachable on demand`,
      );
      assert.ok(
        statSync(path.join(REPO_ROOT, appendix)).size > 0,
        `${appendix} is missing or empty`,
      );
    });
  }
});
