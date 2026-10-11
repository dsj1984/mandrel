// tests/lib/orchestration/story-close/ratchet-shrink-writeback.test.js
//
// Story #5626 — at close, dead-export pairs (both modes) and cyclomatic rows
// the Story's tree no longer produces are deleted (or lowered) in ONE
// `baseline-refresh:` commit. The write-back never adds a row or raises a
// value. knip, the cyclomatic scan and git are injected; the baselines live in
// a temp dir.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { runRatchetShrinkWriteback } from '../../../../.agents/scripts/lib/orchestration/story-close/ratchet-shrink-writeback.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';

const QUIET = { info: () => {}, warn: () => {} };
const DEFAULT_REL = 'baselines/dead-exports.json';
const PROD_REL = 'baselines/dead-exports-production.json';
const CYC_REL = 'baselines/cyclomatic.json';

const DEFAULT_ROWS = [
  { file: 'a.js', symbol: 'one' },
  { file: 'a.js', symbol: 'two' },
];
const PROD_ROWS = [
  { file: 'a.js', symbol: 'one' },
  { file: 'b.js', symbol: '*' },
];
const CYC_ROWS = [
  { file: 'x.js', methodsAboveCeiling: 2, maxCyclomatic: 20 },
  { file: 'y.js', methodsAboveCeiling: 1, maxCyclomatic: 14 },
];

function seed() {
  const root = makeTempDir('ratchet-shrink-');
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const write = (rel, env) =>
    fs.writeFileSync(path.join(root, rel), `${JSON.stringify(env, null, 2)}\n`);
  write(DEFAULT_REL, {
    $schema: 's',
    kernelVersion: '6.0.0',
    rows: DEFAULT_ROWS,
  });
  write(PROD_REL, {
    $schema: 's',
    kernelVersion: '6.0.0',
    mode: 'production',
    rows: PROD_ROWS,
  });
  write(CYC_REL, { $schema: 'c', ceiling: 12, rows: CYC_ROWS });
  return root;
}

const read = (root, rel) =>
  JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

/** knip envelope reporting `rows` (`symbol: '*'` → a dead file). */
function knipOf(rows) {
  return {
    ok: true,
    envelope: {
      issues: rows.map((r) =>
        r.symbol === '*'
          ? { file: r.file, files: [r.file], exports: [] }
          : { file: r.file, exports: [{ name: r.symbol }] },
      ),
    },
  };
}

function gitStub({ branch = 'story-7', dirty = '', failOn = null } = {}) {
  const calls = [];
  const git = (_cwd, ...args) => {
    calls.push(args);
    const key = args.join(' ');
    if (failOn && key.startsWith(failOn)) throw new Error(`git ${failOn} boom`);
    if (key === 'rev-parse --abbrev-ref HEAD') return branch;
    if (key.startsWith('status --porcelain')) return dirty;
    if (key === 'rev-parse --short HEAD') return 'abc1234';
    return '';
  };
  return { git, calls };
}

function run({
  root = seed(),
  knipDefault = DEFAULT_ROWS,
  knipProd = PROD_ROWS,
  knip,
  scanRows = CYC_ROWS,
  parseErrors = 0,
  git = gitStub(),
} = {}) {
  const out = runRatchetShrinkWriteback({
    cwd: root,
    storyId: 7,
    storyBranch: 'story-7',
    config: {},
    logger: QUIET,
    gitSync: git.git,
    runKnip:
      knip ?? (({ production }) => knipOf(production ? knipProd : knipDefault)),
    scanCyclomatic: () => ({ rows: scanRows, parseErrors }),
    resolveScanScope: () => null,
  });
  return { out, root, calls: git.calls };
}

describe('runRatchetShrinkWriteback — shrink is written (AC-3)', () => {
  test('drops vanished dead-export pairs in both modes and burnt-down cyclomatic rows in ONE baseline-refresh commit', () => {
    const { out, root, calls } = run({
      knipDefault: [DEFAULT_ROWS[0]],
      knipProd: [PROD_ROWS[0]],
      scanRows: [{ file: 'x.js', methodsAboveCeiling: 1, maxCyclomatic: 15 }],
    });
    assert.equal(out.committed, true, JSON.stringify(out));
    assert.deepEqual(out.baselines, [DEFAULT_REL, PROD_REL, CYC_REL]);

    assert.deepEqual(read(root, DEFAULT_REL).rows, [DEFAULT_ROWS[0]]);
    const prod = read(root, PROD_REL);
    assert.deepEqual(prod.rows, [PROD_ROWS[0]]);
    assert.equal(prod.mode, 'production', 'envelope fields survive');
    assert.equal(prod.kernelVersion, '6.0.0');
    assert.deepEqual(read(root, CYC_REL).rows, [
      { file: 'x.js', methodsAboveCeiling: 1, maxCyclomatic: 15 },
    ]);

    const commits = calls.filter((c) => c[0] === 'commit');
    assert.equal(commits.length, 1);
    assert.match(
      commits[0][2],
      /^chore\(baselines\): baseline-refresh: drop burnt-down ratchet rows \(story #7\)$/,
    );
    const body = commits[0][4];
    assert.match(body, /- a\.js: two/);
    assert.match(body, /- b\.js: \*/);
    assert.match(body, /- y\.js: removed/);
    assert.match(body, /- x\.js: 2\/20 -> 1\/15/);
    assert.deepEqual(
      calls.find((c) => c[0] === 'add'),
      ['add', '--', DEFAULT_REL, PROD_REL, CYC_REL],
    );
  });

  test('writes only the baselines that shrank', () => {
    const { out, root } = run({ knipDefault: [DEFAULT_ROWS[1]] });
    assert.deepEqual(out.baselines, [DEFAULT_REL]);
    assert.equal(out.skipped[PROD_REL], 'no-shrink');
    assert.equal(out.skipped[CYC_REL], 'no-shrink');
    assert.deepEqual(read(root, PROD_REL).rows, PROD_ROWS);
  });
});

describe('runRatchetShrinkWriteback — never adds or raises (AC-3)', () => {
  test('a dead-export addition leaves that baseline for the check to fail on', () => {
    const { out, root } = run({
      knipDefault: [DEFAULT_ROWS[0], { file: 'new.js', symbol: 'fresh' }],
    });
    assert.equal(out.committed, false);
    assert.equal(out.skipped[DEFAULT_REL], 'not-a-shrink');
    assert.deepEqual(read(root, DEFAULT_REL).rows, DEFAULT_ROWS);
  });

  test('a cyclomatic addition or worsening is never written, even beside a removal', () => {
    // y.js burnt down, but z.js is a brand-new breach: no write at all.
    const { out, root } = run({
      scanRows: [
        CYC_ROWS[0],
        { file: 'z.js', methodsAboveCeiling: 1, maxCyclomatic: 13 },
      ],
    });
    assert.equal(out.skipped[CYC_REL], 'not-a-shrink');
    assert.deepEqual(read(root, CYC_REL).rows, CYC_ROWS);
    const worse = run({
      scanRows: [{ file: 'x.js', methodsAboveCeiling: 1, maxCyclomatic: 25 }],
    });
    assert.equal(worse.out.skipped[CYC_REL], 'not-a-shrink');
  });

  test('a lowered count with an unchanged max keeps the max', () => {
    const { root } = run({
      scanRows: [
        { file: 'x.js', methodsAboveCeiling: 1, maxCyclomatic: 20 },
        CYC_ROWS[1],
      ],
    });
    assert.deepEqual(read(root, CYC_REL).rows[0], {
      file: 'x.js',
      methodsAboveCeiling: 1,
      maxCyclomatic: 20,
    });
  });
});

describe('runRatchetShrinkWriteback — fail-safe skips', () => {
  test('a failed or unusable knip run never reads as "every row removed"', () => {
    const failed = run({ knip: () => ({ ok: false, error: 'spawn' }) });
    assert.equal(failed.out.skipped[DEFAULT_REL], 'knip-failed');
    assert.equal(failed.out.skipped[PROD_REL], 'knip-failed');
    const unusable = run({ knip: () => ({ ok: true, envelope: {} }) });
    assert.equal(unusable.out.skipped[DEFAULT_REL], 'knip-report-unusable');
    assert.deepEqual(read(unusable.root, DEFAULT_REL).rows, DEFAULT_ROWS);
  });

  test('a cyclomatic parse error never reads as a burnt-down row', () => {
    const { out, root } = run({ scanRows: [CYC_ROWS[0]], parseErrors: 1 });
    assert.equal(out.skipped[CYC_REL], 'parse-errors');
    assert.deepEqual(read(root, CYC_REL).rows, CYC_ROWS);
  });

  test('a throwing knip is a named skip for that baseline only', () => {
    const { out } = run({
      knip: ({ production }) => {
        if (production) throw new Error('knip blew up');
        return knipOf([DEFAULT_ROWS[0]]);
      },
    });
    assert.equal(out.committed, true);
    assert.deepEqual(out.baselines, [DEFAULT_REL]);
    assert.equal(out.skipped[PROD_REL], 'failed: knip blew up');
  });

  test('a missing baseline or a ceiling mismatch skips', () => {
    const root = seed();
    fs.rmSync(path.join(root, DEFAULT_REL));
    fs.writeFileSync(
      path.join(root, CYC_REL),
      JSON.stringify({ ceiling: 10, rows: CYC_ROWS }),
    );
    const { out } = run({ root, scanRows: [] });
    assert.equal(out.skipped[DEFAULT_REL], 'no-baseline');
    assert.equal(out.skipped[CYC_REL], 'ceiling-mismatch');
  });

  test('guards: missing context, wrong branch, dirty baseline, git failure', () => {
    assert.equal(
      runRatchetShrinkWriteback({ logger: QUIET }).reason,
      'missing-context',
    );
    assert.equal(
      run({ git: gitStub({ branch: 'main' }) }).out.reason,
      'wrong-branch',
    );
    assert.equal(
      run({ git: gitStub({ dirty: ` M ${CYC_REL}` }) }).out.reason,
      'dirty-tree',
    );
    assert.match(
      run({ git: gitStub({ failOn: 'status' }) }).out.reason,
      /^git-failed: /,
    );
  });

  test('a rejected commit restores every written baseline', () => {
    const git = gitStub({ failOn: 'commit' });
    const { out, calls } = run({ git, knipDefault: [DEFAULT_ROWS[0]] });
    assert.equal(out.committed, false);
    assert.match(out.reason, /^git-failed: git commit boom/);
    assert.deepEqual(
      calls.find((c) => c[0] === 'restore'),
      ['restore', '--staged', '--worktree', '--', DEFAULT_REL],
    );
  });

  test('nothing to shrink is a named skip listing each baseline', () => {
    const { out } = run();
    assert.equal(out.committed, false);
    assert.match(out.reason, /^no-shrink: dead-exports\.json=no-shrink/);
  });
});
