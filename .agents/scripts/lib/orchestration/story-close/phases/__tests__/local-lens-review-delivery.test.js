/**
 * local-lens-review-delivery.test.js — contract test for the Story-scope
 * lens-delivery activation (Story #4627, AC-1).
 *
 * Before this Story the Story-scope lens pass selected and materialized lenses
 * but delivered their content to no reader: `runLocalLensReview` invoked
 * `runAuditSuite` with neither substitutions nor an `artifactPrefix`, so the
 * `{{changedFiles}}` token never resolved and no artifact was written. This
 * gate pins the delivery contract:
 *
 *   - the lens pass threads the resolved `{{changedFiles}}` / `{{ticketId}}`
 *     substitutions and a Story-scoped `artifactPrefix` into `runAuditSuite`;
 *   - the close's stdout names each materialized artifact path under a
 *     host-MUST-walk contract, so the default (non-reading) review provider no
 *     longer renders the pass inert.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runLocalLensReview } from '../local-lens-review.js';

/** A `runAuditSuite` spy that records its args and returns a fixed envelope. */
function auditSuiteSpy(envelope) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return envelope;
  };
  fn.calls = calls;
  return fn;
}

/** Collect the `(tag, msg)` progress lines a run emits. */
function progressCollector() {
  const lines = [];
  const progress = (tag, msg) => lines.push({ tag, msg });
  progress.lines = lines;
  progress.joined = () => lines.map((l) => l.msg).join('\n');
  return progress;
}

test('delivers substituted lens prompts: resolved changedFiles token + Story-scoped artifactPrefix', async () => {
  const runAuditSuiteFn = auditSuiteSpy({
    metadata: {},
    findings: [],
    workflows: [
      {
        audit: 'audit-clean-code',
        artifactPath: 'temp/audits/audit-story-4627-audit-clean-code.md',
      },
    ],
  });

  await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4627',
    changedFiles: ['.agents/scripts/a.js', '.agents/scripts/b.js'],
    storyId: 4627,
    progress: progressCollector(),
    selectLocalLensesFn: () => ['audit-clean-code'],
    runAuditSuiteFn,
  });

  assert.equal(runAuditSuiteFn.calls.length, 1);
  const call = runAuditSuiteFn.calls[0];
  // The {{changedFiles}} token resolves to the newline-joined diff the lens
  // `## Scope` block reads, and {{ticketId}} resolves to the Story id.
  assert.equal(
    call.substitutions.changedFiles,
    '.agents/scripts/a.js\n.agents/scripts/b.js',
  );
  assert.equal(call.substitutions.ticketId, '4627');
  // Artifacts are scoped to the Story so concurrent closes cannot clobber.
  assert.equal(call.artifactPrefix, 'story-4627');
});

test('names each materialized artifact path under a host-MUST-walk contract', async () => {
  const runAuditSuiteFn = auditSuiteSpy({
    metadata: {},
    findings: [],
    workflows: [
      {
        audit: 'audit-clean-code',
        artifactPath: 'temp/audits/audit-story-4627-audit-clean-code.md',
      },
      {
        audit: 'audit-quality',
        artifactPath: 'temp/audits/audit-story-4627-audit-quality.md',
      },
    ],
  });
  const progress = progressCollector();

  const out = await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4627',
    changedFiles: ['.agents/scripts/a.js'],
    storyId: 4627,
    progress,
    selectLocalLensesFn: () => ['audit-clean-code', 'audit-quality'],
    runAuditSuiteFn,
  });

  const stdout = progress.joined();
  assert.match(stdout, /host MUST read\/walk each/);
  assert.match(stdout, /audit-story-4627-audit-clean-code\.md/);
  assert.match(stdout, /audit-story-4627-audit-quality\.md/);
  // The paths are also carried on the returned envelope for the caller.
  assert.deepEqual(out.artifactPaths, [
    'temp/audits/audit-story-4627-audit-clean-code.md',
    'temp/audits/audit-story-4627-audit-quality.md',
  ]);
});

test('emits no roster when no lens matched (nothing to walk)', async () => {
  const runAuditSuiteFn = auditSuiteSpy({
    metadata: {},
    findings: [],
    workflows: [],
  });
  const progress = progressCollector();

  await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4627',
    changedFiles: ['docs/unrelated.md'],
    storyId: 4627,
    progress,
    selectLocalLensesFn: () => [],
    runAuditSuiteFn,
  });

  assert.equal(runAuditSuiteFn.calls.length, 0);
  assert.doesNotMatch(progress.joined(), /host MUST/);
});

test('the roster lists only lenses that actually wrote an artifact', async () => {
  const runAuditSuiteFn = auditSuiteSpy({
    metadata: {},
    findings: [],
    workflows: [
      { audit: 'a', artifactPath: 'temp/audits/audit-story-4627-a.md' },
      { audit: 'b', artifactPath: null },
      { audit: 'c', artifactPath: 'temp/audits/audit-story-4627-c.md' },
    ],
  });
  const progress = progressCollector();
  const out = await runLocalLensReview({
    baseRef: 'main',
    headRef: 'story-4627',
    changedFiles: ['.agents/scripts/a.js'],
    storyId: 4627,
    progress,
    selectLocalLensesFn: () => ['a', 'b', 'c'],
    runAuditSuiteFn,
  });
  const stdout = progress.joined();
  assert.match(stdout, /audit-story-4627-a\.md/);
  assert.match(stdout, /audit-story-4627-c\.md/);
  assert.doesNotMatch(stdout, /audit-story-4627-b\.md/);
  // A lens whose materialization wrote no artifact contributes no path.
  assert.deepEqual(out.artifactPaths, [
    'temp/audits/audit-story-4627-a.md',
    'temp/audits/audit-story-4627-c.md',
  ]);
});
