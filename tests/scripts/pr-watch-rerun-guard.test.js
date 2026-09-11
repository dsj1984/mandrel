/**
 * pr-watch-rerun-guard.test.js — Story #4865.
 *
 * `rules/ci-remediation.md` § Verifier forbids re-running a failed job to
 * reach green, and until this Story nothing enforced it: a red check wrote
 * a digest nobody read, and native auto-merge stayed armed, so a rerun-green
 * merged silently.
 *
 * The enforcement point is `pr-watch-with-update.js`, and it acts on the
 * FIRST RED — GitHub's auto-merge fires server-side and races any post-green
 * detection. These tests pin the whole contract through `runPrWatch` with
 * every `gh` port injected (no network, no filesystem outside a temp root,
 * no `process.exit`):
 *
 *   - red    → auto-merge disarmed, digest records the head SHA (AC-2)
 *   - red    → a disarm FAILURE is a blocker, not a warning (AC-2)
 *   - green + digest, SAME head → exit 1 + agent::blocked (AC-3)
 *   - green + digest, NEW head  → exit 0, digest retired, re-armed (AC-4)
 *   - green, no digest          → exit 0 unchanged; still-running → 2 (AC-5)
 *   - the failure guidance no longer tells the operator to re-run (AC-6)
 */

import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyGreenVerdict,
  disarmAutoMerge,
  formatRerunViolation,
  resolvePrHeadSha,
} from '../../.agents/scripts/lib/orchestration/ci-rerun-guard.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { runPrWatch } from '../../.agents/scripts/pr-watch-with-update.js';

const RED_CHECKS = {
  status: 0,
  stdout: JSON.stringify([
    { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
    { name: 'baselines', state: 'FAILURE', bucket: 'fail' },
  ]),
  stderr: '',
};

const GREEN_CHECKS = {
  status: 0,
  stdout: JSON.stringify([
    { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
    { name: 'baselines', state: 'SUCCESS', bucket: 'pass' },
  ]),
  stderr: '',
};

const CLEAN_VIEW = {
  status: 0,
  stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
  stderr: '',
};

function recorder() {
  const lines = { info: [], warn: [], error: [], print: [] };
  return {
    lines,
    logger: {
      info: (m) => lines.info.push(m),
      warn: (m) => lines.warn.push(m),
      error: (m) => lines.error.push(m),
      debug: () => {},
    },
    print: (l) => lines.print.push(l),
  };
}

async function withTempRoot(fn) {
  const dir = makeTempDir('mandrel-rerun-guard-');
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A digest as the red path would have written it. */
function seedDigest(tempRoot, storyId, digest) {
  const file = path.join(tempRoot, `story-${storyId}-ci-digest.json`);
  writeFileSync(file, JSON.stringify(digest, null, 2));
  writeFileSync(path.join(tempRoot, `story-${storyId}-ci-digest.md`), '# seed');
  return file;
}

/** Baseline watch options: red or green checks, everything else stubbed. */
function watchOpts({ checks, tempRoot, storyId, rec, ...rest }) {
  return {
    prNumber: 4865,
    storyId,
    config: null,
    tempRoot,
    pollIntervalMs: 0,
    maxResumes: 0,
    sleepFn: async () => {},
    ghPrChecksFn: () => checks,
    ghPrViewFn: () => CLEAN_VIEW,
    logger: rec.logger,
    print: rec.print,
    ...rest,
  };
}

describe('no-rerun guard — red path (AC-1, AC-2)', () => {
  it('disarms native auto-merge and records the head SHA on the first red', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      const disarmCalls = [];
      const written = [];
      const code = await runPrWatch(
        watchOpts({
          checks: RED_CHECKS,
          tempRoot,
          storyId: 4865,
          rec,
          headShaFn: () => 'red-sha',
          disarmAutoMergeFn: (args) => {
            disarmCalls.push(args);
            return { disarmed: true, alreadyUnarmed: false, detail: 'ok' };
          },
          writeDigestFn: (args) => {
            written.push(args);
            return { jsonPath: '/tmp/d.json', mdPath: '/tmp/d.md' };
          },
          blockDeliveryFn: async () => ({ blocked: true, commented: true }),
        }),
      );

      assert.equal(code, 1, 'a red check still exits 1');
      assert.equal(disarmCalls.length, 1, 'auto-merge is disarmed on red');
      assert.equal(
        written[0].headSha,
        'red-sha',
        'digest carries the head SHA',
      );
      assert.equal(written[0].failures[0].name, 'baselines');

      const out = JSON.parse(rec.lines.print[0]);
      assert.equal(out.rerunGuard.autoMergeDisarmed, true);
      assert.equal(out.rerunGuard.headSha, 'red-sha');
      assert.equal(out.classification, 'baseline');
    });
  });

  it('treats a disarm FAILURE as a blocker, not a warning', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      const blocks = [];
      const code = await runPrWatch(
        watchOpts({
          checks: RED_CHECKS,
          tempRoot,
          storyId: 4865,
          rec,
          headShaFn: () => 'red-sha',
          disarmAutoMergeFn: () => ({
            disarmed: false,
            alreadyUnarmed: false,
            detail: 'gh-exit-1: HTTP 403',
          }),
          writeDigestFn: () => null,
          blockDeliveryFn: async (args) => {
            blocks.push(args);
            return { blocked: true, commented: true };
          },
        }),
      );

      assert.equal(code, 1);
      assert.equal(blocks.length, 1, 'the delivery is routed to blocked');
      assert.match(blocks[0].body, /could not be disarmed/i);
      assert.ok(
        rec.lines.error.some((l) => /BLOCKER/.test(l)),
        'the disarm failure is reported as a blocker',
      );
      const out = JSON.parse(rec.lines.print[0]);
      assert.equal(out.rerunGuard.autoMergeDisarmed, false);
      assert.equal(out.rerunGuard.blocked, true);
    });
  });

  it('no longer instructs the operator to re-run the suite until green (AC-6)', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      await runPrWatch(
        watchOpts({
          checks: RED_CHECKS,
          tempRoot,
          storyId: 4865,
          rec,
          headShaFn: () => 'red-sha',
          disarmAutoMergeFn: () => ({
            disarmed: true,
            alreadyUnarmed: false,
            detail: 'ok',
          }),
          writeDigestFn: () => null,
          blockDeliveryFn: async () => ({ blocked: true, commented: true }),
        }),
      );

      const all = [...rec.lines.error, ...rec.lines.warn, ...rec.lines.info];
      assert.ok(
        !all.some((l) => /re-run the suite/i.test(l)),
        'the forbidden affordance is gone',
      );
      assert.ok(
        all.some((l) => /re-running the failed job is forbidden/i.test(l)),
        'the guidance names the prohibition instead',
      );
    });
  });
});

describe('no-rerun guard — green path (AC-3, AC-4, AC-5)', () => {
  it('blocks a green reached on the SAME head SHA the red was recorded against', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      seedDigest(tempRoot, 4865, {
        storyId: 4865,
        prNumber: 4865,
        headSha: 'same-sha',
        failingCheck: 'baselines',
        runId: '5150',
        runUrl: 'https://github.com/o/r/actions/runs/5150',
        classification: 'baseline',
        logTail: 'crap: methodsAbove20 regressed',
        priorReds: [],
      });
      const blocks = [];
      let reArmed = 0;
      const code = await runPrWatch(
        watchOpts({
          checks: GREEN_CHECKS,
          tempRoot,
          storyId: 4865,
          rec,
          headShaFn: () => 'same-sha',
          reArmAutoMergeFn: async () => {
            reArmed += 1;
            return { enabled: true };
          },
          blockDeliveryFn: async (args) => {
            blocks.push(args);
            return { blocked: true, commented: true };
          },
        }),
      );

      assert.equal(code, 1, 'a rerun-green must NOT exit 0');
      assert.equal(reArmed, 0, 'a rerun-green never re-arms auto-merge');
      assert.equal(blocks.length, 1);
      // Story #5300 — the block names the filing MECHANISM, not a label to
      // hand-type into `gh issue create`.
      assert.match(blocks[0].body, /file-ci-gap\.js/);
      assert.match(blocks[0].body, /runs\/5150/, 'the run link is carried');
      assert.match(
        blocks[0].body,
        /methodsAbove20 regressed/,
        'the failure signature is carried',
      );
      assert.ok(
        existsSync(path.join(tempRoot, 'story-4865-ci-digest.json')),
        'the unresolved digest is NOT retired by a violation',
      );

      const out = JSON.parse(rec.lines.print[0]);
      assert.equal(out.green, true);
      assert.equal(out.rerunGuard.verdict, 'rerun');
      assert.equal(out.rerunGuard.blocked, true);
    });
  });

  it('fails closed when the red carries no head SHA to adjudicate against', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      seedDigest(tempRoot, 4865, {
        storyId: 4865,
        prNumber: 4865,
        failingCheck: 'baselines',
        classification: 'baseline',
        logTail: '',
      });
      const code = await runPrWatch(
        watchOpts({
          checks: GREEN_CHECKS,
          tempRoot,
          storyId: 4865,
          rec,
          headShaFn: () => 'whatever',
          blockDeliveryFn: async () => ({ blocked: true, commented: true }),
        }),
      );

      assert.equal(code, 1);
      const out = JSON.parse(rec.lines.print[0]);
      assert.equal(out.rerunGuard.verdict, 'unverifiable');
    });
  });

  it('lets a green on a NEW head SHA through, retiring the digest and re-arming', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      seedDigest(tempRoot, 4865, {
        storyId: 4865,
        prNumber: 4865,
        headSha: 'old-sha',
        failingCheck: 'baselines',
        runUrl: 'https://github.com/o/r/actions/runs/1',
        classification: 'baseline',
        logTail: '',
      });
      const blocks = [];
      const reArms = [];
      const code = await runPrWatch(
        watchOpts({
          checks: GREEN_CHECKS,
          tempRoot,
          storyId: 4865,
          rec,
          headShaFn: () => 'new-sha',
          reArmAutoMergeFn: async (args) => {
            reArms.push(args);
            return { enabled: true };
          },
          blockDeliveryFn: async (args) => {
            blocks.push(args);
            return { blocked: true, commented: true };
          },
        }),
      );

      assert.equal(code, 0, 'fix-at-source is unobstructed');
      assert.equal(blocks.length, 0, 'nothing is blocked');
      assert.equal(reArms.length, 1, 'auto-merge is re-armed');
      assert.equal(reArms[0].prNumber, 4865);
      assert.equal(
        existsSync(path.join(tempRoot, 'story-4865-ci-digest.json')),
        false,
        'the resolved digest is retired',
      );
      assert.equal(
        existsSync(path.join(tempRoot, 'story-4865-ci-digest.md')),
        false,
      );

      const out = JSON.parse(rec.lines.print[0]);
      assert.equal(out.rerunGuard.verdict, 'fix-at-source');
      assert.equal(out.rerunGuard.reArmed, true);
    });
  });

  it('exits 0 unchanged for a delivery that never went red (no digest)', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      let reArmed = 0;
      const code = await runPrWatch(
        watchOpts({
          checks: GREEN_CHECKS,
          tempRoot,
          storyId: 4865,
          rec,
          headShaFn: () => {
            throw new Error('the head SHA must not be probed with no digest');
          },
          reArmAutoMergeFn: async () => {
            reArmed += 1;
            return { enabled: true };
          },
        }),
      );

      assert.equal(code, 0);
      assert.equal(reArmed, 0, 'a clean green never re-arms');
      const out = JSON.parse(rec.lines.print[0]);
      assert.equal(out.green, true);
      assert.equal(out.rerunGuard.verdict, 'clean');
    });
  });

  it('leaves the still-running (exit 2) contract untouched', async () => {
    await withTempRoot(async (tempRoot) => {
      const rec = recorder();
      const code = await runPrWatch(
        watchOpts({
          checks: {
            status: 8,
            stdout: JSON.stringify([
              { name: 'baselines', state: 'IN_PROGRESS', bucket: 'pending' },
            ]),
            stderr: '',
          },
          tempRoot,
          storyId: 4865,
          rec,
          maxPolls: 1,
          headShaFn: () => {
            throw new Error('a still-running watch must not probe the head');
          },
          disarmAutoMergeFn: () => {
            throw new Error('a still-running watch must not disarm');
          },
        }),
      );

      assert.equal(code, 2);
      const out = JSON.parse(rec.lines.print[0]);
      assert.equal(out.stillRunning, true);
      assert.equal(out.rerunGuard, undefined);
    });
  });
});

describe('ci-rerun-guard units', () => {
  it('classifyGreenVerdict discriminates on the head SHA', () => {
    assert.equal(
      classifyGreenVerdict({ digest: null, headSha: 'a' }).verdict,
      'clean',
    );
    assert.equal(
      classifyGreenVerdict({ digest: { headSha: 'a' }, headSha: 'a' }).verdict,
      'rerun',
    );
    assert.equal(
      classifyGreenVerdict({ digest: { headSha: 'a' }, headSha: 'b' }).verdict,
      'fix-at-source',
    );
    assert.equal(
      classifyGreenVerdict({ digest: { headSha: 'a' }, headSha: null }).verdict,
      'unverifiable',
    );
    assert.equal(
      classifyGreenVerdict({ digest: {}, headSha: 'a' }).verdict,
      'unverifiable',
    );
  });

  it('resolvePrHeadSha reads headRefOid and degrades to null', () => {
    assert.equal(
      resolvePrHeadSha({
        prRef: '1',
        cwd: '.',
        spawnFn: () => ({
          status: 0,
          stdout: JSON.stringify({ headRefOid: 'abc' }),
        }),
      }),
      'abc',
    );
    assert.equal(
      resolvePrHeadSha({
        prRef: '1',
        cwd: '.',
        spawnFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      }),
      null,
    );
    assert.equal(
      resolvePrHeadSha({
        prRef: '1',
        cwd: '.',
        spawnFn: () => ({ status: 0, stdout: 'not json' }),
      }),
      null,
    );
  });

  it('disarmAutoMerge separates a never-armed PR from a genuine failure', () => {
    assert.deepEqual(
      disarmAutoMerge({
        prRef: '1',
        cwd: '.',
        spawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
      { disarmed: true, alreadyUnarmed: false, detail: 'disarmed' },
    );

    const notArmed = disarmAutoMerge({
      prRef: '1',
      cwd: '.',
      spawnFn: () => ({
        status: 1,
        stdout: '',
        stderr: 'auto-merge is not enabled for this pull request',
      }),
    });
    assert.equal(notArmed.disarmed, true);
    assert.equal(notArmed.alreadyUnarmed, true);

    const failed = disarmAutoMerge({
      prRef: '1',
      cwd: '.',
      spawnFn: () => ({ status: 1, stdout: '', stderr: 'HTTP 403: forbidden' }),
    });
    assert.equal(failed.disarmed, false);
    assert.match(failed.detail, /gh-exit-1/);

    const threw = disarmAutoMerge({
      prRef: '1',
      cwd: '.',
      spawnFn: () => {
        throw new Error('ENOENT');
      },
    });
    assert.equal(threw.disarmed, false);
    assert.match(threw.detail, /gh-spawn-error/);
  });

  it('formatRerunViolation carries the run link and failure signature', () => {
    const body = formatRerunViolation({
      digest: {
        failingCheck: 'test',
        runUrl: 'https://github.com/o/r/actions/runs/9',
        classification: 'test',
        logTail: '\n  AssertionError: expected 1 to equal 2\nmore\n',
      },
      headSha: 'sha',
      prNumber: 12,
      reason: 'green on the SAME head SHA',
    });
    assert.match(body, /runs\/9/);
    assert.match(body, /AssertionError: expected 1 to equal 2/);
    assert.match(body, /file-ci-gap\.js/);
    assert.match(
      body,
      /pre-existing\|capacity\|unreproducible-tier/,
      'the violation names the verdicts that route to a filing',
    );
  });
});
