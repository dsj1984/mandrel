// tests/lib/test-run-credit.test.js
//
// Story #5313 — a green bare `npm test` in a Story worktree deposits the
// `test` gate's evidence record close reads. Every seam is injected so no
// test spawns git or touches the real temp tree.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  depositTestRunCredit,
  predictsTestEvidenceCredit,
  reportTestRunCredit,
  resolveEvidenceRoot,
  storyIdFromBranch,
} from '../../.agents/scripts/lib/test-run-credit.js';
import { hashCommandConfig } from '../../.agents/scripts/lib/validation-evidence.js';

/** A git stub answering the three questions the depositor asks. */
const gitFor = ({
  branch = 'story-4321',
  sha = 'a'.repeat(40),
  tree = 'b'.repeat(40),
  commonDir = '/repo/.git',
} = {}) => {
  const answers = {
    'rev-parse --abbrev-ref HEAD': branch,
    'rev-parse HEAD': sha,
    'rev-parse HEAD^{tree}': tree,
    'rev-parse --git-common-dir': commonDir,
  };
  return (_cwd, ...args) => {
    const out = answers[args.join(' ')];
    return out === null || out === undefined
      ? { status: 128, stdout: '' }
      : { status: 0, stdout: `${out}\n` };
  };
};

describe('storyIdFromBranch', () => {
  test('reads the Story id off story-<id> and nothing else', () => {
    assert.equal(storyIdFromBranch('story-4321'), 4321);
    for (const bad of ['main', 'story-', 'story-0', 'feat/story-4', null]) {
      assert.equal(storyIdFromBranch(bad), null, String(bad));
    }
  });
});

describe('resolveEvidenceRoot', () => {
  test('maps a worktree onto the main checkout via the common git dir', () => {
    assert.equal(
      resolveEvidenceRoot(
        '/repo/.worktrees/story-4321',
        gitFor({ commonDir: '/repo/.git' }),
      ),
      '/repo',
    );
  });

  test('resolves a relative common dir against the cwd', () => {
    assert.equal(
      resolveEvidenceRoot('/repo', gitFor({ commonDir: '.git' })),
      path.resolve('/repo'),
    );
  });

  test('is null off a readable .git', () => {
    assert.equal(resolveEvidenceRoot('/x', gitFor({ commonDir: null })), null);
    assert.equal(
      resolveEvidenceRoot('/x', gitFor({ commonDir: '/x/notgit' })),
      null,
    );
  });
});

describe('depositTestRunCredit', () => {
  test('AC-5: a green full run on a Story branch records the test gate close reads', () => {
    const records = [];
    const cwd = '/repo/.worktrees/story-4321';
    const out = depositTestRunCredit({
      cwd,
      tier: 'full',
      status: 0,
      durationMs: 1234,
      gitSpawnFn: gitFor(),
      recordPassFn: (record, opts) => records.push({ record, opts }),
    });
    assert.deepEqual(out, {
      deposited: true,
      reason: 'recorded',
      storyId: 4321,
      sha: 'a'.repeat(40),
    });
    assert.equal(records.length, 1);
    const { record, opts } = records[0];
    assert.equal(record.gateName, 'test');
    assert.equal(record.storyId, 4321);
    assert.equal(record.sha, 'a'.repeat(40));
    assert.equal(record.inputFingerprint, `tree:${'b'.repeat(40)}`);
    assert.equal(record.durationMs, 1234);
    // The hash must be the one close computes for its own `test` gate.
    assert.equal(
      record.configHash,
      hashCommandConfig({ cmd: 'npm', args: ['test'], cwd }),
    );
    // Keyspace: the MAIN checkout, standalone — where close reads.
    assert.deepEqual(opts, { cwd: '/repo', standalone: true });
  });

  test('deposits nothing for a red run, a partial tier, or a non-Story branch', () => {
    const never = () => {
      throw new Error('must not record');
    };
    assert.equal(
      depositTestRunCredit({
        cwd: '/x',
        status: 1,
        gitSpawnFn: gitFor(),
        recordPassFn: never,
      }).reason,
      'run-not-green',
    );
    assert.equal(
      depositTestRunCredit({
        cwd: '/x',
        tier: 'quick',
        gitSpawnFn: gitFor(),
        recordPassFn: never,
      }).reason,
      'not-full-tier',
    );
    assert.equal(
      depositTestRunCredit({
        cwd: '/x',
        gitSpawnFn: gitFor({ branch: 'main' }),
        recordPassFn: never,
      }).reason,
      'not-a-story-branch',
    );
  });

  test('an unreadable tree or a failing write is reported, never thrown', () => {
    assert.equal(
      depositTestRunCredit({
        cwd: '/x',
        gitSpawnFn: gitFor({ sha: null }),
        recordPassFn: () => {},
      }).reason,
      'tree-unreadable',
    );
    const out = depositTestRunCredit({
      cwd: '/x',
      gitSpawnFn: gitFor(),
      recordPassFn: () => {
        throw new Error('disk full');
      },
    });
    assert.equal(out.deposited, false);
    assert.match(out.reason, /record-failed: disk full/);
  });
});

describe('reportTestRunCredit', () => {
  test('logs the outcome by reason and returns the deposit', () => {
    const lines = [];
    const ok = reportTestRunCredit({
      cwd: '/repo/.worktrees/story-4321',
      gitSpawnFn: gitFor(),
      recordPassFn: () => {},
      log: (line) => lines.push(line),
    });
    assert.equal(ok.deposited, true);
    assert.match(
      lines[0],
      /deposited the close test credit for story #4321 at aaaaaaa/,
    );

    const no = reportTestRunCredit({
      cwd: '/x',
      status: 2,
      gitSpawnFn: gitFor(),
      recordPassFn: () => {},
      log: (line) => lines.push(line),
    });
    assert.equal(no.deposited, false);
    assert.match(lines[1], /no close test credit deposited \(run-not-green\)/);
  });
});

describe('predictsTestEvidenceCredit — the read side close consults', () => {
  test('is true only for a credited record under the same keys the deposit wrote', () => {
    const cwd = '/repo/.worktrees/story-9';
    const seen = [];
    const credited = predictsTestEvidenceCredit({
      storyId: 9,
      cwd,
      evidenceCwd: '/repo',
      gitSpawnImpl: gitFor(),
      shouldSkipImpl: (input, opts) => {
        seen.push({ input, opts });
        return { skip: true, reason: 'evidence-match' };
      },
      log: (line) => seen.push(line),
    });
    assert.equal(credited, true);
    assert.equal(seen[0].input.gateName, 'test');
    assert.equal(seen[0].input.currentSha, 'a'.repeat(40));
    assert.equal(seen[0].input.inputFingerprint, `tree:${'b'.repeat(40)}`);
    assert.equal(
      seen[0].input.configHash,
      hashCommandConfig({ cmd: 'npm', args: ['test'], cwd }),
    );
    assert.deepEqual(seen[0].opts, { cwd: '/repo', standalone: true });
    assert.match(String(seen[1]), /registering the plain `test` gate/);
  });

  test('every uncertainty resolves false — never a manufactured credit', () => {
    const base = { cwd: '/x', gitSpawnImpl: gitFor() };
    assert.equal(predictsTestEvidenceCredit({ ...base, storyId: null }), false);
    assert.equal(predictsTestEvidenceCredit({ storyId: 9, cwd: '' }), false);
    assert.equal(
      predictsTestEvidenceCredit({
        ...base,
        storyId: 9,
        gitSpawnImpl: gitFor({ sha: null }),
      }),
      false,
    );
    assert.equal(
      predictsTestEvidenceCredit({
        ...base,
        storyId: 9,
        shouldSkipImpl: () => ({ skip: false, reason: 'no-record' }),
      }),
      false,
    );
    assert.equal(
      predictsTestEvidenceCredit({
        ...base,
        storyId: 9,
        shouldSkipImpl: () => {
          throw new Error('unreadable');
        },
      }),
      false,
    );
  });
});
