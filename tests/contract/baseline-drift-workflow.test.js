// tests/contract/baseline-drift-workflow.test.js
/**
 * The nightly full-scope baseline re-score.
 *
 * Every other baseline gate in this repository is diff-scoped: it reads the
 * committed rows for the files a change touched. `baseline-drift.yml` is the
 * only thing that re-scores the tree, so drift in an untouched file is
 * invisible without it. That makes the workflow load-bearing in a way a
 * scheduled job usually is not — nobody watches a nightly, so if it silently
 * stops measuring, the gap it was built to close reopens unnoticed.
 *
 * These pin the three properties that failure mode turns on:
 *
 *   1. the job actually invokes the drift CLI;
 *   2. it passes `--require-scored`, without which a kind the detector cannot
 *      score returns `{ ok: true, skipped }` and the run goes green having
 *      measured nothing (the exact fail-open this Story closed);
 *   3. it stays off the per-PR path, so the duplication Story #5004 removed
 *      is not quietly reintroduced under a new name.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.github/workflows/baseline-drift.yml',
);

const source = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = yaml.load(source);
const job = workflow.jobs['maintainability-drift'];
/** The step that runs the CLI, found by the command rather than by name. */
const driftStep = job.steps.find((s) =>
  String(s.run ?? '').includes('check-baseline-drift.js'),
);

describe('baseline-drift.yml — the only full-scope re-score', () => {
  it('runs the drift CLI', () => {
    assert.ok(
      driftStep,
      'no step in the `maintainability-drift` job invokes check-baseline-drift.js',
    );
  });

  it('passes --require-scored, so a kind that cannot be scored reds', () => {
    assert.match(
      driftStep.run,
      /--require-scored/,
      'without --require-scored a skipped kind exits 0 and the nightly is ' +
        'green while measuring nothing — the fail-open this job exists to avoid',
    );
  });

  it('stays off the per-PR path', () => {
    // `on:` parses as the YAML boolean `true` — 1.1 semantics, which js-yaml
    // still applies to bare `on`.
    const triggers = Object.keys(workflow[true] ?? workflow.on ?? {});
    assert.deepEqual(
      triggers.filter((t) => t === 'pull_request' || t === 'push'),
      [],
      'a per-change trigger here reintroduces the duplication Story #5004 removed',
    );
    assert.ok(triggers.includes('schedule'), 'expected a schedule trigger');
  });

  it('can file the tracking issue it promises', () => {
    assert.equal(
      workflow.permissions?.issues,
      'write',
      'the job opens/updates/closes a meta::baseline-drift issue; without ' +
        '`issues: write` those gh calls fail and the only surviving signal ' +
        'is a red run nobody is watching',
    );
  });

  it('re-scores duplication too, feeding the same tracking issue', () => {
    assert.match(
      driftStep.run,
      /--gate duplication --require-scored/,
      'the duplication baseline has no other automated full-scope writer; ' +
        'without this run it drifts silently between hand refreshes',
    );
    assert.match(driftStep.run, /--gate maintainability --require-scored/);
    assert.match(
      driftStep.run,
      /code=\$code" >> "\$GITHUB_OUTPUT"/,
      'both runs must fold into the one `code` output the issue steps read',
    );
    const issueStep = job.steps.find((s) =>
      /meta::baseline-drift/.test(String(s.run ?? '')),
    );
    assert.match(String(issueStep?.if), /steps\.drift\.outputs\.code/);
  });

  it('fails the run on drift rather than only filing an issue', () => {
    const failStep = job.steps.find((s) => /exit 1/.test(String(s.run ?? '')));
    assert.ok(
      failStep,
      'no step fails the run when the drift CLI exits non-zero',
    );
    assert.match(
      String(failStep.if),
      /steps\.drift\.outputs\.code/,
      "the failing step must be gated on the drift step's exit code",
    );
  });
});
