/**
 * Story #4994 — contract tests over the `webServer`-tier prose.
 *
 * Both surfaces under test are executable in the only sense that matters: they
 * are the instructions an agent runs on when a browser tier fails. The defect
 * this Story fixed was entirely in the instructions — a delivery agent had no
 * documented way to exercise a Playwright `webServer` suite, and the CI-triage
 * rule offered no landing for a tier that genuinely cannot be run, so `flaky`
 * dead-ended into a fix-at-source route that requires reproduction.
 *
 * No code test can catch a regression in prose, so these pin the claims that
 * carry the behavior:
 *
 *  1. The `playwright` skill documents the attach-don't-boot seam, names the
 *     abort signature verbatim, and carries the constraint in its Policy
 *     Capsule (AC-1..AC-3).
 *  2. `ci-remediation.md` defines the `unreproducible-tier` verdict, routes it
 *     to Option 2, and gates it behind a proof bar (AC-4, AC-5).
 *  3. Rerunning to green stays forbidden under every verdict, the new one
 *     included (AC-6).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const PLAYWRIGHT_SKILL = '.agents/skills/stack/qa/playwright/SKILL.md';
const CI_REMEDIATION = '.agents/rules/ci-remediation.md';

/**
 * The verbatim line Playwright aborts on when it supervises a server that
 * detaches. It is the recognition cue the whole seam hangs off — an agent that
 * cannot match this string against the prose has to diagnose from scratch.
 */
const ABORT_SIGNATURE = 'Process from config.webServer exited early';

describe("the playwright skill documents the attach-don't-boot seam (Story #4994, AC-1..AC-3)", () => {
  it('names the abort signature verbatim', () => {
    assert.ok(
      read(PLAYWRIGHT_SKILL).includes(ABORT_SIGNATURE),
      `${PLAYWRIGHT_SKILL} must quote "${ABORT_SIGNATURE}" so the failure is recognized on sight rather than re-diagnosed`,
    );
  });

  it('names reuseExistingServer as the mechanism', () => {
    assert.match(
      read(PLAYWRIGHT_SKILL),
      /reuseExistingServer/,
      `${PLAYWRIGHT_SKILL} must name reuseExistingServer — it is what stops Playwright supervising a process it did not start`,
    );
  });

  it('states that Playwright must never own a server it did not start', () => {
    const text = read(PLAYWRIGHT_SKILL).toLowerCase();
    assert.ok(
      text.includes('never let playwright own the lifetime') ||
        text.includes('never own the lifetime'),
      `${PLAYWRIGHT_SKILL} must state the lifetime-ownership constraint, not merely the mechanism`,
    );
  });

  it('carries the constraint in the Policy Capsule, not only the body', () => {
    const text = read(PLAYWRIGHT_SKILL);
    const capsuleStart = text.indexOf('## Policy Capsule');
    assert.notEqual(
      capsuleStart,
      -1,
      `${PLAYWRIGHT_SKILL} must keep its Policy Capsule heading`,
    );
    // The capsule runs to the next h2; a constraint below that line is invisible
    // on engagement, which is the whole point of the capsule.
    const afterCapsule = text.indexOf('\n## ', capsuleStart + 1);
    const capsule = text.slice(
      capsuleStart,
      afterCapsule === -1 ? text.length : afterCapsule,
    );
    assert.match(
      capsule,
      /reuseExistingServer/,
      `${PLAYWRIGHT_SKILL}'s Policy Capsule must carry the seam — a constraint only in the body is not read on engagement`,
    );
  });

  it('gives an ordered procedure and a bounded fallback', () => {
    const text = read(PLAYWRIGHT_SKILL);
    assert.match(
      text,
      /1\.\s+\*\*Boot the server out-of-band/,
      `${PLAYWRIGHT_SKILL} must give the ordered boot-then-attach procedure`,
    );
    assert.match(
      text,
      /When no attachable origin exists/,
      `${PLAYWRIGHT_SKILL} must name the fallback for a tier with no attachable origin`,
    );
    assert.match(
      text,
      /unreproducible-tier/,
      `${PLAYWRIGHT_SKILL}'s fallback must route to the ci-remediation verdict rather than dead-ending`,
    );
  });
});

describe('ci-remediation defines the unreproducible-tier verdict (Story #4994, AC-4..AC-6)', () => {
  it('lists the verdict in the Verdicts table routing to Option 2', () => {
    const row = read(CI_REMEDIATION)
      .split('\n')
      .find(
        (line) =>
          line.startsWith('|') && line.includes('**unreproducible-tier**'),
      );
    assert.ok(row, `${CI_REMEDIATION} must carry an unreproducible-tier row`);
    assert.match(
      row,
      /Option 2/,
      'the unreproducible-tier verdict must route to Option 2 — Option 1 requires a reproduction that is by definition unavailable',
    );
    assert.match(
      row,
      /meta::framework-gap/,
      'the verdict must name the label the escalation is filed under',
    );
  });

  it('gates the verdict behind a proof bar, as capacity is', () => {
    const text = read(CI_REMEDIATION);
    assert.match(
      text,
      /\*\*Unreproducible must be proven, not inferred\.\*\*/,
      `${CI_REMEDIATION} must carry the proof bar — without it the verdict launders any suite an agent failed to run`,
    );
    assert.match(
      text,
      /The attempted attach/,
      'the proof bar must require the attach attempt to have been worked',
    );
    assert.match(
      text,
      /The observed signature/,
      'the proof bar must require the observed abort signature',
    );
    assert.match(
      text,
      /the verdict is unavailable and the failure routes as it did\s+before/,
      'the prose must state what happens when the evidence is absent',
    );
  });

  it('escalates on first encounter rather than spending the timebox', () => {
    assert.match(
      read(CI_REMEDIATION),
      /Unrunnable tier → escalate immediately/,
      `${CI_REMEDIATION} must route the verdict through the immediate-escalation branch — the cost this Story removes is the burned timebox`,
    );
  });

  it('admits at most one rerun, and only for a filed environmental verdict', () => {
    // Story #5343 — `unreproducible-tier` and `capacity` earn ONE rerun once
    // `file-ci-gap.js` has recorded the verdict for the current head SHA.
    // What must not drift: the allowance being read as an open exemption.
    const text = read(CI_REMEDIATION);
    assert.match(
      text,
      /once `file-ci-gap\.js` has recorded a\s+`capacity` or `unreproducible-tier` verdict for the \*\*current head\s+SHA\*\*/,
      `${CI_REMEDIATION} must gate the rerun on a recorded filing for the current head`,
    );
    assert.match(
      text,
      /The allowance is spent when it is honoured/,
      `${CI_REMEDIATION} must say the allowance is one-shot`,
    );
    assert.match(
      text,
      /real\s+red that routes to \*\*Option 1\*\*/,
      `${CI_REMEDIATION} must route the second red back to fix-at-source`,
    );
  });

  it('points at the skill for the seam instead of restating it', () => {
    assert.match(
      read(CI_REMEDIATION),
      /skills\/stack\/qa\/playwright\/SKILL\.md/,
      `${CI_REMEDIATION} must cite the playwright skill — the seam has one prose home`,
    );
  });
});
