// tests/scripts/story-handoff.test.js
//
// Story #5518 — the story-worker's tail is one deterministic command. The
// engine runs preflight → base merge → credited run → seat → push → held
// review, prints one envelope, hands fixable failures back as
// `fix-required` (exit 2) and blocks (exit 1) only on what the worker cannot
// change by editing the branch. Every seam is injected: no real git, suite or
// provider runs here.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDefaultGates,
  resolveCreditedDepositor,
} from '../../.agents/scripts/lib/close-validation/gates.js';
import { runStoryHandoff } from '../../.agents/scripts/lib/orchestration/story-handoff.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { runStoryHandoffCli } from '../../.agents/scripts/story-handoff.js';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.agents',
  'scripts',
  'story-handoff.js',
);

const STORY = 5518;
const HEAD = 'a'.repeat(40);
const SEATED_HEAD = 'b'.repeat(40);
const CAPTURE_SCRIPTS = { test: 'x', 'test:coverage': 'y' };

let tempRoot;
beforeEach(() => {
  tempRoot = makeTempDir('mandrel-story-handoff-');
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const configFor = (overrides = {}) => ({
  project: { baseBranch: 'main', paths: { tempRoot } },
  ...overrides,
});

/**
 * A git double over a tiny mutable world: HEAD, the remote branch sha, and
 * whether the tree is dirty (the seat scripts dirty it).
 */
function gitWorld({
  head = HEAD,
  remote = null,
  lsRemoteFails = false,
  branch = `story-${STORY}`,
} = {}) {
  const world = { head, remote, dirty: [], calls: [] };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  world.git = (_cwd, ...args) => {
    world.calls.push(args);
    const [verb] = args;
    if (verb === 'branch') return ok(`${branch}\n`);
    if (verb === 'rev-parse') return ok(`${world.head}\n`);
    if (verb === 'status') {
      // gitSpawn trims stdout, so the first ` M` line loses its space.
      return ok(
        world.dirty
          .map((p) => ` M ${p}`)
          .join('\n')
          .trim(),
      );
    }
    if (verb === 'ls-remote') {
      if (lsRemoteFails) {
        return { status: 128, stdout: '', stderr: 'Could not resolve host' };
      }
      return ok(world.remote ? `${world.remote}\trefs/heads/${branch}\n` : '');
    }
    if (verb === 'add') return ok();
    if (verb === 'commit') {
      world.head = SEATED_HEAD;
      world.dirty = [];
      return ok();
    }
    return { status: 1, stdout: '', stderr: `unexpected git ${verb}` };
  };
  return world;
}

/**
 * A child-process double keyed on the script (or binary) each step spawns.
 * `outputs[key]` is `{ status, stdout }`; the default is a clean pass.
 */
function commandDouble(world, outputs = {}) {
  const calls = [];
  const defaults = {
    npm: { status: 0, stdout: 'lint clean' },
    'quality-preview.js': { status: 0, stdout: 'preview clean' },
    'coverage-capture.js': {
      status: 0,
      stdout: '[coverage-capture] Wrote content-digest capture stamp.',
    },
    'evidence-gate.js': { status: 0, stdout: '[evidence-gate] ✓ test passed' },
    'update-crap-baseline.js': { status: 0, stdout: 'seated: 0' },
    'update-maintainability-baseline.js': { status: 0, stdout: 'seated: 0' },
    git: { status: 0, stdout: '' },
  };
  const run = async (cmd, args) => {
    const production = args.includes('--production') ? ' --production' : '';
    const key = cmd === 'node' ? `${path.basename(args[0])}${production}` : cmd;
    calls.push({ key, cmd, args });
    const out = outputs[key] ?? defaults[key] ?? { status: 0, stdout: '' };
    if (key === 'git' && out.status === 0) world.remote = world.head;
    if (/seated: [1-9]/.test(out.stdout ?? '')) {
      world.dirty = ['baselines/crap.json'];
    }
    return { status: out.status, stdout: out.stdout ?? '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

function harness({
  world = gitWorld(),
  outputs,
  scripts = CAPTURE_SCRIPTS,
  sync = { synced: true, kind: 'merge-commit', changedPaths: ['x.js'] },
  heldDeposit = null,
  deposit = {
    halted: false,
    severity: { critical: 0, high: 0, medium: 1, suggestion: 2 },
  },
  config = configFor(),
  cwd = '/work',
  // `null` is an unreadable change set: no incremental skip is predicted.
  changed = null,
} = {}) {
  const runCommand = commandDouble(world, outputs);
  const blocks = [];
  const reviews = [];
  const deps = {
    git: world.git,
    runCommand,
    syncFromBase: async () => sync,
    probeReview: () => ({ deposit: heldDeposit }),
    computeReview: async (input) => {
      reviews.push(input);
      return { written: true, path: '/tmp/story-review.json', deposit };
    },
    readPackageScriptsFn: () => scripts,
    getChangedFilesFn: () => changed,
    block: async (args) => {
      blocks.push(args);
    },
    logDir: path.join(tempRoot, 'orchestration'),
  };
  const run = () => runStoryHandoff({ storyId: STORY, cwd, config }, deps);
  return { run, runCommand, blocks, reviews, world, deps };
}

const stepNames = (envelope) => envelope.steps.map((s) => s.name);
const spawned = (runCommand) => runCommand.calls.map((c) => c.key);

describe('story-handoff — the happy path (AC-1)', () => {
  test('runs every step in order and settles ready with the pushed head and tally', async () => {
    const h = harness();
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(stepNames(envelope), [
      'preflight',
      'base-merge',
      'credited-run',
      'seat',
      'push',
      'review',
    ]);
    assert.equal(envelope.headSha, HEAD);
    assert.equal(h.world.remote, HEAD, 'the pushed ref equals HEAD');
    assert.deepEqual(envelope.review, {
      critical: 0,
      high: 0,
      medium: 1,
      suggestion: 2,
    });
    assert.deepEqual(spawned(h.runCommand), [
      'npm',
      'quality-preview.js',
      'coverage-capture.js',
      'update-crap-baseline.js',
      'update-maintainability-baseline.js',
      'git',
    ]);
    assert.equal(h.reviews.length, 1, 'the held review is computed once');
    assert.equal(h.blocks.length, 0);
  });

  test('the preflight scores against origin/<base> and the capture runs in the worktree', async () => {
    const h = harness();
    await h.run();
    const preview = h.runCommand.calls.find(
      (c) => c.key === 'quality-preview.js',
    );
    assert.deepEqual(preview.args.slice(1), ['--changed-since', 'origin/main']);
    const capture = h.runCommand.calls.find(
      (c) => c.key === 'coverage-capture.js',
    );
    assert.deepEqual(capture.args.slice(1), ['--cwd', '/work']);
  });

  test('seated rows are committed as a baseline-refresh and the capture credit survives the seat commit', async () => {
    const h = harness({
      outputs: {
        'update-crap-baseline.js': { status: 0, stdout: 'seated: 3' },
      },
    });
    const { envelope } = await h.run();
    const add = h.world.calls.find((c) => c[0] === 'add');
    assert.deepEqual(add, ['add', '--', 'baselines/crap.json']);
    const commit = h.world.calls.find((c) => c[0] === 'commit');
    assert.match(
      commit.join(' '),
      /chore\(baselines\): baseline-refresh: seat rows for new methods \(refs #5518\)/,
    );
    assert.equal(envelope.headSha, SEATED_HEAD);
    assert.equal(envelope.status, 'ready');
  });

  test('on the evidence-gate path the seat runs before the suite so its commit cannot void the tree-keyed credit', async () => {
    const h = harness({ scripts: { test: 'x' } });
    const { envelope } = await h.run();
    assert.deepEqual(stepNames(envelope).slice(2, 4), ['seat', 'credited-run']);
    const gate = h.runCommand.calls.find((c) => c.key === 'evidence-gate.js');
    assert.deepEqual(gate.args.slice(1), [
      '--standalone',
      '--scope-id',
      '5518',
      '--gate',
      'test',
      '--worktree',
      '/work',
      '--',
      'npm',
      'test',
    ]);
  });
});

describe('story-handoff — the preflight runs the standalone ratchets (#5528)', () => {
  const RATCHET_BASELINES = {
    'check-dead-exports.js': 'dead-exports.json',
    'check-dead-exports.js --production': 'dead-exports-production.json',
    'check-arch-cycles.js': 'arch-cycles.json',
    'check-cyclomatic.js': 'cyclomatic.json',
  };

  /** A worktree seeded with the named ratchets' committed baselines. */
  function seededWorktree(keys = Object.keys(RATCHET_BASELINES)) {
    const cwd = path.join(tempRoot, 'wt');
    mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
    for (const key of keys) {
      writeFileSync(
        path.join(cwd, 'baselines', RATCHET_BASELINES[key]),
        '{}',
        'utf8',
      );
    }
    return cwd;
  }

  const ratchetCalls = (runCommand) =>
    spawned(runCommand).filter((k) => k in RATCHET_BASELINES);

  test('every seeded ratchet runs in the worktree after lint and quality-preview', async () => {
    const h = harness({ cwd: seededWorktree() });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.deepEqual(spawned(h.runCommand).slice(0, 6), [
      'npm',
      'quality-preview.js',
      ...Object.keys(RATCHET_BASELINES),
    ]);
    assert.match(envelope.steps[0].detail, /dead-exports-production/);
  });

  test('a test-only export ends fix-required at preflight with the production evidence, before the suite or the push (AC-1)', async () => {
    const h = harness({
      cwd: seededWorktree(),
      outputs: {
        'check-dead-exports.js --production': {
          status: 1,
          stdout:
            '+ lib/x.js: onlyForTests\n[dead-exports:production] added=1 removed=0 (gate fail)',
        },
      },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'preflight');
    assert.match(envelope.evidencePath, /preflight-dead-exports-production/);
    assert.match(envelope.steps.at(-1).detail, /lib\/x\.js: onlyForTests/);
    const keys = spawned(h.runCommand);
    assert.ok(!keys.includes('coverage-capture.js'), 'no credited run');
    assert.ok(!keys.includes('git'), 'no push');
  });

  const failing = [
    [
      'an added import cycle',
      'check-arch-cycles.js',
      '+ a.js -> b.js -> a.js\n[arch-cycles] added=1 removed=0 (gate fail)',
      /arch-cycles ratchet finding: \+ a\.js -> b\.js -> a\.js/,
    ],
    [
      'a worsened over-ceiling function',
      'check-cyclomatic.js',
      '! lib/y.js: worst function c=20 (recorded 14)\n[cyclomatic] ceiling=12 added=0 worsened=1 improved=0 removed=0 (gate fail)',
      /cyclomatic ratchet finding: ! lib\/y\.js/,
    ],
  ];
  for (const [label, key, stdout, detail] of failing) {
    test(`${label} is fix-required at preflight with that ratchet's evidence (AC-2)`, async () => {
      const h = harness({
        cwd: seededWorktree(),
        outputs: { [key]: { status: 1, stdout } },
      });
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 2);
      assert.equal(envelope.failedStep, 'preflight');
      assert.ok(envelope.evidencePath, 'names the evidence log');
      assert.match(envelope.steps.at(-1).detail, detail);
    });
  }

  test('a `(gate fail)` line is a finding even on exit 0', async () => {
    const h = harness({
      cwd: seededWorktree(),
      outputs: {
        'check-dead-exports.js': {
          status: 0,
          stdout: '[dead-exports] added=1 removed=0 (gate fail)',
        },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.failedStep, 'preflight');
  });

  test('a ratchet whose baseline is absent is not run (AC-3)', async () => {
    const h = harness({ cwd: seededWorktree(['check-cyclomatic.js']) });
    await h.run();
    assert.deepEqual(ratchetCalls(h.runCommand), ['check-cyclomatic.js']);
    const bare = harness();
    await bare.run();
    assert.deepEqual(ratchetCalls(bare.runCommand), []);
  });

  test('a clean branch reaches ready and an unchanged HEAD skips the ratchets on re-run (AC-3)', async () => {
    const h = harness({
      cwd: seededWorktree(),
      sync: { synced: true, kind: 'noop-already-current' },
    });
    const first = await h.run();
    assert.equal(first.envelope.status, 'ready');
    h.runCommand.calls.length = 0;
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.equal(envelope.steps[0].outcome, 'skipped');
    assert.deepEqual(ratchetCalls(h.runCommand), []);
  });
});

describe('story-handoff — one depositor predicate (AC-2)', () => {
  test('CRAP on + test:coverage → coverage capture; anything else → the evidence-gate test run', async () => {
    const crapOff = configFor({
      delivery: { quality: { gates: { crap: { enabled: false } } } },
    });
    for (const [scripts, config, depositor, script] of [
      [CAPTURE_SCRIPTS, configFor(), 'coverage-capture', 'coverage-capture.js'],
      [{ test: 'x' }, configFor(), 'test', 'evidence-gate.js'],
      [CAPTURE_SCRIPTS, crapOff, 'test', 'evidence-gate.js'],
    ]) {
      const h = harness({ scripts, config });
      const { envelope } = await h.run();
      assert.equal(envelope.depositor, depositor);
      assert.ok(spawned(h.runCommand).includes(script));
      rmSync(path.join(tempRoot, 'orchestration'), {
        recursive: true,
        force: true,
      });
    }
  });

  test('close registers the gate that credits the same depositor', () => {
    const names = (config, scripts) =>
      buildDefaultGates({ config, packageScripts: scripts }).map((g) => g.name);
    assert.ok(names({}, CAPTURE_SCRIPTS).includes('coverage-capture'));
    assert.ok(!names({}, CAPTURE_SCRIPTS).includes('test'));
    assert.ok(names({}, { test: 'x' }).includes('test'));
    assert.ok(!names({}, { test: 'x' }).includes('coverage-capture'));
  });
});

// Story #5548 — #5544's handoff credited coverage-capture's incremental
// no-change skip (no suite ran) while close ran the plain `test` gate red.
describe('story-handoff — a predicted incremental skip is never the depositor', () => {
  // Default `crap.targetDirs` is `['src']`; none of these sit under it.
  const OUTSIDE_TARGETS = [
    '.agents/mods/mandrel-status/index.tsx',
    'docs/decisions.md',
  ];

  test('a diff with no file under crap.targetDirs deposits via the evidence-gate test run', async () => {
    const h = harness({ changed: OUTSIDE_TARGETS });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.depositor, 'test');
    assert.ok(spawned(h.runCommand).includes('evidence-gate.js'));
    assert.ok(!spawned(h.runCommand).includes('coverage-capture.js'));
    const step = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(step.outcome, 'ran');
  });

  test('close and the handoff resolve the same depositor from the one predicate', async () => {
    for (const [changed, expected] of [
      [OUTSIDE_TARGETS, 'test'],
      [['src/app.js', ...OUTSIDE_TARGETS], 'coverage-capture'],
    ]) {
      const getChangedFilesImpl = () => changed;
      const predicate = resolveCreditedDepositor({
        config: configFor(),
        scripts: CAPTURE_SCRIPTS,
        cwd: '/work',
        baseBranch: 'main',
        getChangedFilesImpl,
      });
      assert.equal(predicate, expected);
      const gates = buildDefaultGates({
        config: configFor(),
        packageScripts: CAPTURE_SCRIPTS,
        cwd: '/work',
        baseBranch: 'main',
        getChangedFilesImpl,
        presentBaselines: [],
      });
      const capture = gates.find((g) => g.name === 'coverage-capture');
      const closeDepositor =
        gates.some((g) => g.name === 'test') && capture?.skip
          ? 'test'
          : 'coverage-capture';
      assert.equal(closeDepositor, expected);
      const h = harness({ changed });
      const { envelope } = await h.run();
      assert.equal(envelope.depositor, expected);
      rmSync(path.join(tempRoot, 'orchestration'), {
        recursive: true,
        force: true,
      });
    }
  });

  test('a capture that printed only a no-change skip is fix-required, not credit', async () => {
    for (const stdout of [
      '[coverage-capture] Incremental mode: no changed files under [src] vs main — skipping capture.',
      '[coverage-capture] Affected mode: no changed files under [src] vs main — skipping capture.',
      '[coverage-capture] No changed files under [src] — skipping capture.',
    ]) {
      const h = harness({
        outputs: { 'coverage-capture.js': { status: 0, stdout } },
      });
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 2, stdout);
      assert.equal(envelope.failedStep, 'credited-run');
      rmSync(path.join(tempRoot, 'orchestration'), {
        recursive: true,
        force: true,
      });
    }
  });
});

describe('story-handoff — idempotent re-run (AC-3)', () => {
  test('an unchanged tree runs no suite, seats nothing, pushes nothing, recomputes no review, and is still ready', async () => {
    const h = harness({ sync: { synced: true, kind: 'noop-already-current' } });
    await h.run();
    h.runCommand.calls.length = 0;
    h.reviews.length = 0;
    h.deps.probeReview = () => ({
      deposit: { halted: false, severity: { critical: 0 } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(spawned(h.runCommand), [], 'nothing is spawned');
    assert.equal(h.reviews.length, 0);
    assert.ok(envelope.steps.every((s) => s.outcome === 'skipped'));
  });

  test('a fresh capture stamp is judged by its signal, not the exit code', async () => {
    const h = harness({
      outputs: {
        'coverage-capture.js': {
          status: 0,
          stdout: '[coverage-capture] Coverage is fresh — skipping capture.',
        },
      },
    });
    const { envelope } = await h.run();
    const step = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(step.outcome, 'skipped');
  });

  test('exit 0 with no credit signal deposits nothing and is fix-required', async () => {
    const h = harness({
      outputs: { 'coverage-capture.js': { status: 0, stdout: 'silence' } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'credited-run');
  });
});

describe('story-handoff — fix-required hands the failure back (AC-4)', () => {
  const cases = [
    ['a lint finding', { outputs: { npm: { status: 1 } } }, 'preflight'],
    [
      'a quality-preview finding',
      { outputs: { 'quality-preview.js': { status: 1 } } },
      'preflight',
    ],
    [
      'a red suite',
      { outputs: { 'coverage-capture.js': { status: 1 } } },
      'credited-run',
      /red suite/,
    ],
    [
      'a suite deferred by the full-suite lock',
      { outputs: { 'coverage-capture.js': { status: 75 } } },
      'credited-run',
      /deferred/,
    ],
    [
      'a suite timeout',
      { outputs: { 'coverage-capture.js': { status: 124 } } },
      'credited-run',
      /timed out/,
    ],
    [
      'a seat refusal',
      { outputs: { 'update-crap-baseline.js': { status: 1 } } },
      'seat',
    ],
    ...['fetch first', 'non-fast-forward'].map((why) => [
      `a ${why} push rejection`,
      {
        outputs: {
          git: {
            status: 1,
            stdout: ` ! [rejected]        story-5518 -> story-5518 (${why})`,
          },
        },
      },
      'push',
      /git fetch origin story-\d+, git merge origin\/story-\d+/,
    ]),
    [
      'a failing pre-push hook',
      {
        outputs: {
          git: { status: 1, stdout: 'husky - pre-push script failed' },
        },
      },
      'push',
    ],
  ];
  for (const [label, opts, failedStep, detail] of cases) {
    test(`${label} → fix-required, exit 2, evidence path, labels untouched`, async () => {
      const h = harness(opts);
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 2);
      assert.equal(envelope.status, 'fix-required');
      assert.equal(envelope.failedStep, failedStep);
      assert.ok(envelope.evidencePath, 'names the evidence log');
      if (detail) {
        assert.match(envelope.steps.at(-1).detail, detail);
      }
      assert.equal(h.blocks.length, 0, 'no label is written');
    });
  }

  test('a base-merge conflict names the conflicting files', async () => {
    const h = harness({
      sync: {
        synced: false,
        kind: 'conflict',
        conflictFiles: ['a.js', 'b.md'],
      },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'base-merge');
    assert.deepEqual(envelope.conflictFiles, ['a.js', 'b.md']);
    assert.equal(h.blocks.length, 0);
  });

  // Story #5520 AC-2 — the shared sync resolved a baseline-only conflict, so
  // the handoff proceeds and names what it took from the base.
  test('a baseline-only conflict the sync resolved proceeds and is named', async () => {
    const h = harness({
      sync: {
        synced: true,
        kind: 'merge-commit',
        changedPaths: ['baselines/coverage.json'],
        resolvedBaselineFiles: ['baselines/coverage.json'],
      },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.status, 'ready');
    const merge = envelope.steps.find((s) => s.name === 'base-merge');
    assert.match(merge.detail, /baseline-only conflict resolved/);
    assert.match(merge.detail, /baselines\/coverage\.json/);
    assert.equal(h.blocks.length, 0);
  });

  test('a CRITICAL held review is fix-required with the deposit as evidence', async () => {
    const h = harness({
      deposit: { halted: true, severity: { critical: 1 } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'review');
    assert.equal(envelope.evidencePath, '/tmp/story-review.json');
    assert.equal(h.blocks.length, 0);
  });

  test('uncommitted work is refused before any step runs', async () => {
    const world = gitWorld();
    world.dirty = ['src/a.js'];
    const h = harness({ world });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'precheck');
    assert.deepEqual(spawned(h.runCommand), []);
  });

  test('a review provider throw is reported, never a stop', async () => {
    const h = harness();
    h.deps.computeReview = async () => {
      throw new Error('provider down');
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.steps.at(-1).outcome, 'error');
  });
});

describe('story-handoff — blocked only on what the worker cannot change (AC-5)', () => {
  const cases = [
    [
      'a remote-rejected hook decline',
      {
        outputs: {
          git: {
            status: 1,
            stdout:
              ' ! [remote rejected] story-5518 -> story-5518 (pre-receive hook declined)',
          },
        },
      },
      'push-rejected',
    ],
    [
      'a permission denial',
      {
        outputs: {
          git: {
            status: 1,
            stdout:
              'remote: Permission to o/r.git denied to bot.\nfatal: unable to access: The requested URL returned error: 403',
          },
        },
      },
      'push-rejected',
    ],
    [
      'an unreachable remote',
      { world: gitWorld({ lsRemoteFails: true }) },
      'remote-unreachable',
    ],
    [
      'an unconfirmed base branch',
      { sync: { synced: false, kind: 'fetch-failed', stderr: 'no such ref' } },
      'base-branch-unconfirmed',
    ],
    [
      'an unregistered baseline merge driver',
      {
        sync: {
          synced: false,
          kind: 'merge-driver-missing',
          stderr: 'driver unset',
        },
      },
      'merge-driver-unregistered',
    ],
  ];
  for (const [label, opts, reason] of cases) {
    test(`${label} → blocked, exit 1, agent::blocked + friction`, async () => {
      const h = harness(opts);
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 1);
      assert.equal(envelope.status, 'blocked');
      assert.equal(envelope.reason, reason);
      assert.equal(h.blocks.length, 1);
      assert.equal(h.blocks[0].storyId, STORY);
      assert.equal(h.blocks[0].reason, reason);
    });
  }
});

describe('story-handoff.js — the CLI', () => {
  test('refuses a missing --story', async () => {
    await assert.rejects(
      () => runStoryHandoffCli([], { resolveConfigImpl: () => ({}) }),
      /--story <id> is required/,
    );
  });

  test('prints the envelope on stdout and returns the exit code', async () => {
    const out = [];
    const seen = [];
    const { exitCode } = await runStoryHandoffCli(
      ['--story', '5518', '--cwd', '/work'],
      {
        resolveConfigImpl: () => ({ project: {} }),
        runHandoffImpl: async (input, deps) => {
          seen.push({ input, deps });
          return { envelope: { status: 'fix-required' }, exitCode: 2 };
        },
        stdout: { write: (s) => out.push(s) },
        stderr: { write: () => {} },
      },
    );
    assert.equal(exitCode, 2);
    assert.equal(JSON.parse(out.join('')).status, 'fix-required');
    assert.equal(seen[0].input.cwd, '/work');
    assert.equal(typeof seen[0].deps.computeReview, 'function');
  });

  test('--help prints the usage without running anything', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /ready \(exit 0\), fix-required \(exit 2\)/);
  });
});

describe('story-handoff — the default block writes the label and the friction comment', () => {
  test('a blocked settle flips agent::blocked through the canonical mutator and posts friction', async () => {
    const updates = [];
    const comments = [];
    const provider = {
      async getTicketComments() {
        return [];
      },
      async postComment(storyId, payload) {
        comments.push({ storyId, body: payload.body });
        return { id: 1 };
      },
      async deleteComment() {},
      async updateTicket(storyId, payload) {
        updates.push({ storyId, payload });
      },
    };
    const h = harness({ world: gitWorld({ lsRemoteFails: true }) });
    delete h.deps.block;
    h.deps.createProviderFn = () => provider;
    const { exitCode } = await h.run();
    assert.equal(exitCode, 1);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].payload.labels.add, ['agent::blocked']);
    assert.match(comments[0].body, /story-handoff blocked: remote-unreachable/);
  });

  test('a fix-required settle writes no label and no comment', async () => {
    const touched = [];
    const h = harness({ outputs: { npm: { status: 1 } } });
    delete h.deps.block;
    h.deps.createProviderFn = () => {
      touched.push('provider');
      return {};
    };
    const { exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.deepEqual(touched, []);
  });
});

describe('story-handoff — the story-progress record (Story #5553)', () => {
  const progressFile = () =>
    path.join(tempRoot, 'orchestration', `story-progress-${STORY}.json`);

  test('AC-2: rewrites the record with stage handoff and the step name before each step runs', async () => {
    const h = harness();
    const observed = [];
    const peek = () => {
      const record = JSON.parse(readFileSync(progressFile(), 'utf8'));
      assert.equal(record.stage, 'handoff');
      assert.equal(record.storyId, STORY);
      assert.equal(record.prNumber, null);
      if (observed.at(-1) !== record.phase) observed.push(record.phase);
    };
    const { runCommand, syncFromBase, computeReview } = h.deps;
    h.deps.runCommand = async (...args) => {
      peek();
      return runCommand(...args);
    };
    h.deps.syncFromBase = async (...args) => {
      peek();
      return syncFromBase(...args);
    };
    h.deps.computeReview = async (...args) => {
      peek();
      return computeReview(...args);
    };
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(observed, stepNames(envelope));
  });

  test('AC-4: an unwritable progress target leaves the envelope and exit code unchanged', async () => {
    const baseline = await harness().run();
    rmSync(path.join(tempRoot, 'orchestration'), {
      recursive: true,
      force: true,
    });
    // A directory squatting on the target fails every rename, portably.
    mkdirSync(progressFile(), { recursive: true });
    const blocked = await harness().run();
    assert.equal(blocked.exitCode, baseline.exitCode);
    assert.deepEqual(blocked.envelope, baseline.envelope);
  });
});
