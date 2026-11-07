// tests/scripts/story-handoff.test.js
//
// Story #5518 — the story-worker's tail is one deterministic command. The
// engine runs base merge → preflight → credited run → seat → post-capture →
// push → held review, prints one envelope, hands fixable failures back as
// `fix-required` (exit 2) and blocks (exit 1) only on what the worker cannot
// change by editing the branch. Every seam is injected: no real git, suite or
// provider runs here.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { spawnStreamAsync } from '../../.agents/scripts/lib/child-exec.js';
import { createLockEventChannel } from '../../.agents/scripts/lib/close-lock-events.js';
import {
  buildDefaultGates,
  resolveCreditedDepositor,
} from '../../.agents/scripts/lib/close-validation/gates.js';
import {
  applyChangedFileScope,
  runCloseValidation,
} from '../../.agents/scripts/lib/close-validation/runner.js';
import { signalsFile } from '../../.agents/scripts/lib/config/temp-paths.js';
import { AGENTRC_SCHEMA } from '../../.agents/scripts/lib/config-settings-schema.js';
import { withFullSuiteLockAsync } from '../../.agents/scripts/lib/full-suite-lock.js';
import { validateSignal } from '../../.agents/scripts/lib/observability/signal-validator.js';
import { runStoryHandoff } from '../../.agents/scripts/lib/orchestration/story-handoff.js';
import { STANDALONE_RATCHETS } from '../../.agents/scripts/lib/standalone-ratchets.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  hashCommandConfig,
  shouldSkip,
} from '../../.agents/scripts/lib/validation-evidence.js';
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
  firstParent = [],
  ancestor = true,
  mergeBase = null,
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
    if (verb === 'rev-list') return ok(firstParent.join('\n'));
    if (verb === 'merge-base' && !args.includes('--is-ancestor')) {
      return mergeBase ? ok(`${mergeBase}\n`) : { status: 1, stdout: '' };
    }
    if (verb === 'merge-base') return { status: ancestor ? 0 : 1 };
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
 * `outputs[key]` is `{ status, stdout }`, or an array answered per call;
 * the default is a clean pass.
 */
function commandKey(cmd, args) {
  if (cmd !== 'node') return cmd;
  const script = path.basename(args[0]);
  // A non-`test` evidence-gate deposit is keyed by its gate (`lint`, `format`).
  const at = args.indexOf('--gate');
  const gate = at === -1 ? null : args[at + 1];
  if (script === 'evidence-gate.js' && gate !== 'test') return gate;
  if (script === 'quality-preview.js' && args.includes('crap')) {
    return 'quality-preview.js --only crap';
  }
  if (script === 'check-baselines.js')
    return gate ? `${script} ${gate}` : script;
  return `${script}${args.includes('--production') ? ' --production' : ''}`;
}

/** Format is scoped out unless a test opts in; lint passes through. */
const scopeOutFormat = ({ gate }) =>
  gate.skip || gate.changedFileScope
    ? { gate, skip: true }
    : { gate, cmd: gate.cmd, args: gate.args, skip: false };

function commandDouble(world, outputs = {}) {
  const calls = [];
  const defaults = {
    lint: { status: 0, stdout: 'lint clean' },
    'quality-preview.js': { status: 0, stdout: 'preview clean' },
    'coverage-capture.js': {
      status: 0,
      stdout: '[coverage-capture] Wrote content-digest capture stamp.',
    },
    'evidence-gate.js': { status: 0, stdout: '[evidence-gate] ✓ test passed' },
    'update-crap-baseline.js': { status: 0, stdout: 'seated: 0' },
    'update-coverage-baseline.js': { status: 0, stdout: 'seated: 0' },
    'update-maintainability-baseline.js': { status: 0, stdout: 'seated: 0' },
    git: { status: 0, stdout: '' },
  };
  const run = async (cmd, args, opts) => {
    const key = commandKey(cmd, args);
    const nth = calls.filter((c) => c.key === key).length;
    calls.push({ key, cmd, args, opts });
    const given = outputs[key];
    const out = (Array.isArray(given) ? given[nth] : given) ??
      defaults[key] ?? { status: 0, stdout: '' };
    if (key === 'git' && out.status === 0 && !out.keepRemote) {
      world.remote = world.head;
    }
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
  // Close's re-score double: no test runs a real jscpd scan.
  rescore = { ran: false, committed: false, reason: 'no-changed-files' },
} = {}) {
  const runCommand = commandDouble(world, outputs);
  const blocks = [];
  const reviews = [];
  const rescores = [];
  const frictions = [];
  const deps = {
    emitFriction: async (record) => {
      frictions.push(record);
      return true;
    },
    runDuplicationRescore: async (input) => {
      rescores.push(input);
      return typeof rescore === 'function' ? rescore(input) : rescore;
    },
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
    now: () => 0,
    evidenceCwd: tempRoot,
    scopeGate: scopeOutFormat,
    presentBaselines: [],
  };
  const run = () => runStoryHandoff({ storyId: STORY, cwd, config }, deps);
  return {
    run,
    runCommand,
    blocks,
    reviews,
    rescores,
    frictions,
    world,
    deps,
  };
}

const stepNames = (envelope) => envelope.steps.map((s) => s.name);
/** The step the envelope stopped on; a started review may trail it. */
const stopStep = (envelope) =>
  envelope.steps.findLast((s) => s.name === envelope.failedStep);
const reviewStep = (envelope) =>
  envelope.steps.find((s) => s.name === 'review');
const spawned = (runCommand) => runCommand.calls.map((c) => c.key);

describe('story-handoff — the happy path (AC-1)', () => {
  test('runs every step in order and settles ready with the pushed head and tally', async () => {
    const h = harness();
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(stepNames(envelope), [
      'base-merge',
      'duplication-rescore',
      'seat-static',
      'preflight',
      'credited-run',
      'seat',
      'post-capture',
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
      'update-maintainability-baseline.js',
      'typecheck',
      'lint',
      'quality-preview.js',
      'coverage-capture.js',
      'update-crap-baseline.js',
      'quality-preview.js --only crap',
      'check-baselines.js',
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

  test('a failed seat commit is fix-required with its git output as evidence', async () => {
    const h = harness({
      outputs: {
        'update-crap-baseline.js': { status: 0, stdout: 'seated: 1' },
      },
    });
    const git = h.world.git;
    h.deps.git = (cwd, ...args) =>
      args[0] === 'commit'
        ? { status: 1, stdout: '', stderr: 'hook rejected' }
        : git(cwd, ...args);
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'seat');
    assert.match(stopStep(envelope).detail, /hook rejected/);
    assert.equal(readFileSync(envelope.evidencePath, 'utf8'), 'hook rejected');
  });

  test('on the evidence-gate path the seat runs before the suite so its commit cannot void the tree-keyed credit', async () => {
    const h = harness({ scripts: { test: 'x' } });
    const { envelope } = await h.run();
    assert.deepEqual(stepNames(envelope).slice(4, 6), ['seat', 'credited-run']);
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

  test('the evidence-gate run wraps project.commands.test, close test gate argv (#5582)', async () => {
    const h = harness({
      scripts: { test: 'x' },
      config: configFor({
        project: {
          baseBranch: 'main',
          paths: { tempRoot },
          commands: { test: 'python3 scripts/validation.py' },
        },
      }),
    });
    await h.run();
    const gate = h.runCommand.calls.find((c) => c.key === 'evidence-gate.js');
    assert.deepEqual(gate.args.slice(-3), [
      '--',
      'python3',
      'scripts/validation.py',
    ]);
  });
});

describe('story-handoff — children resolve config from the worktree (#5729)', () => {
  const CRAP_UPDATER = path.join(path.dirname(CLI), 'update-crap-baseline.js');

  /** A stale parent value — the main checkout's config root. */
  const staleEnv = () => ({ ...process.env, AP_AGENTRC_CWD: '/main-checkout' });

  test('AC-1: the seat and every other child get AP_AGENTRC_CWD = the worktree, overriding the inherited value', async () => {
    const h = harness({ cwd: '/work' });
    h.deps.env = staleEnv();
    await h.run();
    const seat = h.runCommand.calls.find(
      (c) => c.key === 'update-crap-baseline.js',
    );
    assert.equal(seat.opts.env.AP_AGENTRC_CWD, '/work');
    assert.equal(seat.opts.cwd, '/work');
    const credited = h.runCommand.calls.find(
      (c) => c.key === 'coverage-capture.js',
    );
    assert.equal(credited.opts.env.AP_AGENTRC_CWD, '/work');
    for (const call of h.runCommand.calls) {
      assert.equal(call.opts.env.AP_AGENTRC_CWD, '/work', call.key);
    }
  });

  test('AC-3: update-crap-baseline.js run with the seat env resolves the worktree crap.coveragePath', async () => {
    const worktree = path.join(tempRoot, 'wt-config');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(
      path.join(worktree, '.agentrc.json'),
      JSON.stringify({
        project: {
          baseBranch: 'main',
          paths: {
            agentRoot: '.agents',
            docsRoot: 'docs',
            tempRoot: path.join(worktree, 'tmp'),
          },
        },
        delivery: {
          quality: {
            gates: {
              crap: {
                coveragePath: 'worktree-cov/coverage-final.json',
                targetDirs: ['src'],
              },
            },
          },
        },
      }),
    );
    const h = harness({ cwd: worktree });
    h.deps.env = staleEnv();
    await h.run();
    const seat = h.runCommand.calls.find(
      (c) => c.key === 'update-crap-baseline.js',
    );
    // The refresh mode logs its coverage source, then refuses on the
    // missing artifact — nothing is written.
    const child = spawnSync(process.execPath, [CRAP_UPDATER], {
      cwd: seat.opts.cwd,
      env: seat.opts.env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = `${child.stdout}${child.stderr}`;
    assert.match(
      output,
      /Coverage source: worktree-cov\/coverage-final\.json/,
      output,
    );
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
    assert.deepEqual(spawned(h.runCommand).slice(1, 8), [
      'typecheck',
      'lint',
      'quality-preview.js',
      ...Object.keys(RATCHET_BASELINES),
    ]);
    const preflight = envelope.steps.find((st) => st.name === 'preflight');
    assert.match(preflight.detail, /dead-exports-production/);
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
    assert.match(stopStep(envelope).detail, /lib\/x\.js: onlyForTests/);
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
      assert.match(stopStep(envelope).detail, detail);
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

describe('story-handoff — ratchets covered by a whole-tree lint (Story #5964)', () => {
  const RATCHET_KEYS = {
    'check-dead-exports.js': 'dead-exports',
    'check-dead-exports.js --production': 'dead-exports-production',
    'check-arch-cycles.js': 'arch-cycles',
    'check-cyclomatic.js': 'cyclomatic',
  };
  const COVERED = ['dead-exports', 'dead-exports-production', 'cyclomatic'];

  /** Every standalone ratchet's baseline committed in a fresh worktree. */
  function allBaselines() {
    const cwd = path.join(tempRoot, 'wt');
    for (const r of STANDALONE_RATCHETS) {
      mkdirSync(path.dirname(path.join(cwd, r.baseline)), { recursive: true });
      writeFileSync(path.join(cwd, r.baseline), '{}', 'utf8');
    }
    return cwd;
  }

  /** A harness whose config lists `coveredByLint`, recording progress lines. */
  function coveredHarness(coveredByLint = COVERED, opts = {}) {
    const h = harness({
      cwd: allBaselines(),
      config: configFor({
        delivery: { quality: { ratchets: { coveredByLint } } },
      }),
      ...opts,
    });
    h.lines = [];
    h.deps.progress = (_tag, msg) => h.lines.push(msg);
    return h;
  }

  const ratchetCalls = (runCommand) =>
    spawned(runCommand).filter((k) => k in RATCHET_KEYS);
  const coveredLines = (h) =>
    h.lines.filter((m) =>
      / covered by lint \(delivery\.quality\.ratchets\.coveredByLint\)$/.test(
        m,
      ),
    );

  test('AC-4/AC-8: a clean whole-tree lint skips the covered ratchets, runs the rest and reaches ready', async () => {
    const h = coveredHarness();
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(ratchetCalls(h.runCommand), ['check-arch-cycles.js']);
    assert.deepEqual(
      coveredLines(h),
      COVERED.map(
        (k) =>
          `⏭ ${k} covered by lint (delivery.quality.ratchets.coveredByLint)`,
      ),
    );
    const preflight = envelope.steps.find((st) => st.name === 'preflight');
    assert.match(
      preflight.detail,
      /arch-cycles clean; covered by lint: dead-exports, dead-exports-production, cyclomatic$/,
    );
    assert.doesNotMatch(preflight.detail.split(';')[0], /cyclomatic/);
  });

  test('AC-5: a lint credited from fresh evidence covers the ratchets the same way', async () => {
    const h = coveredHarness(COVERED, {
      outputs: {
        lint: { status: 0, stdout: '[evidence-gate] ⏭ lint skipped (fresh)' },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(ratchetCalls(h.runCommand), ['check-arch-cycles.js']);
    assert.equal(coveredLines(h).length, 3);
  });

  test('AC-6: a scoped-out lint covers nothing', async () => {
    const scopedOut = coveredHarness();
    scopedOut.deps.scopeGate = ({ gate }) =>
      gate.name === 'lint' || gate.skip || gate.changedFileScope
        ? { gate, skip: true }
        : { gate, cmd: gate.cmd, args: gate.args, skip: false };
    await scopedOut.run();
    assert.ok(!spawned(scopedOut.runCommand).includes('lint'));
    assert.deepEqual(
      ratchetCalls(scopedOut.runCommand),
      Object.keys(RATCHET_KEYS),
    );
  });

  test('AC-6: a lint narrowed to changed files covers nothing', async () => {
    const narrowed = coveredHarness();
    narrowed.deps.scopeGate = ({ gate }) =>
      gate.skip || gate.changedFileScope
        ? { gate, skip: true }
        : {
            gate,
            cmd: gate.cmd,
            args: gate.name === 'lint' ? [...gate.args, 'a.js'] : gate.args,
            skip: false,
          };
    await narrowed.run();
    assert.deepEqual(
      ratchetCalls(narrowed.runCommand),
      Object.keys(RATCHET_KEYS),
    );
    assert.equal(coveredLines(narrowed).length, 0);
  });

  test('AC-7: a failing lint is fix-required with its evidence and no covered ratchet spawns', async () => {
    const h = coveredHarness(COVERED, {
      outputs: {
        lint: { status: 1, stdout: 'lib/x.js: onlyForTests is unused' },
      },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'preflight');
    assert.match(envelope.evidencePath, /preflight-lint/);
    assert.match(stopStep(envelope).detail, /^lint finding/);
    assert.deepEqual(ratchetCalls(h.runCommand), ['check-arch-cycles.js']);
    assert.equal(coveredLines(h).length, 0);
  });

  test('AC-3: listing every key the schema accepts covers every ratchet the preflight can run', async () => {
    const accepted =
      AGENTRC_SCHEMA.properties.delivery.properties.quality.properties.ratchets
        .properties.coveredByLint.items.enum;
    const h = coveredHarness([...accepted]);
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(ratchetCalls(h.runCommand), []);
    assert.equal(coveredLines(h).length, STANDALONE_RATCHETS.length);
  });
});

describe('story-handoff — one depositor predicate (AC-2)', () => {
  test('coverage or CRAP on + the capture script → coverage capture; anything else → the evidence-gate test run', async () => {
    const gatesOff = (gates) => configFor({ delivery: { quality: { gates } } });
    const crapOff = gatesOff({ crap: { enabled: false } });
    const bothOff = gatesOff({
      crap: { enabled: false },
      coverage: { enabled: false },
    });
    for (const [scripts, config, depositor, script] of [
      [CAPTURE_SCRIPTS, configFor(), 'coverage-capture', 'coverage-capture.js'],
      [{ test: 'x' }, configFor(), 'test', 'evidence-gate.js'],
      [CAPTURE_SCRIPTS, crapOff, 'coverage-capture', 'coverage-capture.js'],
      [CAPTURE_SCRIPTS, bothOff, 'test', 'evidence-gate.js'],
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
      assert.equal(predicate.depositor, expected);
      assert.equal(predicate.skipBranch, expected === 'test');
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

// Story #5961 — the skip branch deposits `testChanged` since the merge-base.
describe('story-handoff — the skip-branch scoped `test` deposit (Story #5961)', () => {
  const MERGE_BASE = '7'.repeat(40);
  const TEST_CHANGED = 'pnpm vitest run --changed $MANDREL_CHANGED_SINCE';
  const DOCS_ONLY = ['docs/decisions.md'];
  const scopedConfig = (testChanged = TEST_CHANGED, coverage = undefined) =>
    configFor({
      project: {
        baseBranch: 'main',
        paths: { tempRoot },
        commands: { test: 'npm test', testChanged },
      },
      ...(coverage ? { delivery: { quality: { gates: { coverage } } } } : {}),
    });
  const testRun = (h) =>
    h.runCommand.calls.find(
      (c) => c.key === 'evidence-gate.js' && c.args.includes('test'),
    );

  test('AC-1: spawns testChanged --changed-since the merge-base and names it in the step', async () => {
    const h = harness({
      changed: DOCS_ONLY,
      config: scopedConfig(),
      world: gitWorld({ mergeBase: MERGE_BASE }),
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.depositor, 'test');
    const { args } = testRun(h);
    const tail = args.slice(args.indexOf('--changed-since'));
    assert.deepEqual(tail, [
      '--changed-since',
      MERGE_BASE,
      '--',
      'pnpm',
      'vitest',
      'run',
      '--changed',
      '$MANDREL_CHANGED_SINCE',
    ]);
    const step = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(step.outcome, 'ran');
    assert.match(
      step.detail,
      new RegExp(`testChanged since ${MERGE_BASE.slice(0, 12)}`),
    );
    assert.ok(
      h.world.calls.some((a) => a.join(' ') === 'merge-base origin/main HEAD'),
    );
  });

  test('AC-4: an unset testChanged or an unreadable merge-base runs the full suite, naming why', async () => {
    for (const [config, world, reason] of [
      [
        scopedConfig(null),
        gitWorld({ mergeBase: MERGE_BASE }),
        /no `project\.commands\.testChanged`/,
      ],
      [scopedConfig(), gitWorld(), /merge-base unreadable/],
    ]) {
      const h = harness({ changed: DOCS_ONLY, config, world });
      const lines = [];
      h.deps.progress = (tag, msg) => lines.push({ tag, msg });
      const { envelope } = await h.run();
      const { args } = testRun(h);
      assert.ok(!args.includes('--changed-since'));
      assert.deepEqual(args.slice(args.indexOf('--') + 1), ['npm', 'test']);
      const step = envelope.steps.find((s) => s.name === 'credited-run');
      assert.match(step.detail, reason);
      assert.ok(lines.some((l) => reason.test(l.msg)));
      rmSync(path.join(tempRoot, 'orchestration'), {
        recursive: true,
        force: true,
      });
    }
  });

  test('AC-5: an inactive capture keeps the full suite and an app Story the capture, whatever testChanged says', async () => {
    const inactive = harness({
      changed: DOCS_ONLY,
      scripts: { test: 'x' },
      config: scopedConfig(),
      world: gitWorld({ mergeBase: MERGE_BASE }),
    });
    await inactive.run();
    assert.ok(!testRun(inactive).args.includes('--changed-since'));
    rmSync(path.join(tempRoot, 'orchestration'), {
      recursive: true,
      force: true,
    });
    const app = harness({
      changed: ['src/app.js'],
      config: scopedConfig(),
      world: gitWorld({ mergeBase: MERGE_BASE }),
    });
    const { envelope } = await app.run();
    assert.equal(envelope.depositor, 'coverage-capture');
    assert.equal(testRun(app), undefined);
  });

  test('AC-8: a test depositor exit 76 defers under defer-to-ci, blocks under block, and 124 is a timeout', async () => {
    const over = { 'evidence-gate.js': { status: 76, stdout: '' } };
    const defer = harness({
      changed: DOCS_ONLY,
      config: scopedConfig(TEST_CHANGED, { onOverBudget: 'defer-to-ci' }),
      world: gitWorld({ mergeBase: MERGE_BASE }),
      outputs: over,
    });
    const deferred = await defer.run();
    assert.equal(deferred.exitCode, 0);
    assert.equal(deferred.envelope.status, 'ready');
    assert.deepEqual(deferred.envelope.coverage, {
      status: 'deferred',
      reason: 'over-budget',
      policy: 'defer-to-ci',
    });
    const step = deferred.envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(step.outcome, 'deferred');
    rmSync(path.join(tempRoot, 'orchestration'), {
      recursive: true,
      force: true,
    });

    const block = harness({
      changed: DOCS_ONLY,
      config: scopedConfig(),
      world: gitWorld({ mergeBase: MERGE_BASE }),
      outputs: over,
    });
    const blocked = await block.run();
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.envelope.status, 'blocked');
    assert.match(blocked.envelope.reason, /onOverBudget/);
    assert.doesNotMatch(blocked.envelope.reason, /capture script/);
    rmSync(path.join(tempRoot, 'orchestration'), {
      recursive: true,
      force: true,
    });

    for (const coverage of [{ onOverBudget: 'defer-to-ci' }, undefined]) {
      const h = harness({
        changed: DOCS_ONLY,
        config: scopedConfig(TEST_CHANGED, coverage),
        world: gitWorld({ mergeBase: MERGE_BASE }),
        outputs: { 'evidence-gate.js': { status: 124, stdout: '' } },
      });
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 2);
      assert.match(stopStep(envelope).detail, /timed out/);
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

  test('a truncated state file is reported through progress and every step re-runs', async () => {
    const h = harness();
    const statePath = path.join(
      tempRoot,
      'orchestration',
      `story-handoff-${STORY}.json`,
    );
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{"state":{"creditHead":"');
    const lines = [];
    h.deps.progress = (tag, msg) => lines.push({ tag, msg });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    const warning = lines.find((l) => l.tag === 'STATE');
    assert.ok(warning, 'the corrupt state file is reported');
    assert.match(warning.msg, /ignoring corrupt .*story-handoff-5518\.json/);
    assert.ok(
      spawned(h.runCommand).includes('coverage-capture.js'),
      'no prior credit is trusted: the credited run spawns',
    );
    assert.equal(envelope.status, 'ready');
    // The run rewrites the state atomically: it parses again afterwards.
    assert.equal(
      JSON.parse(readFileSync(statePath, 'utf8')).envelope.status,
      'ready',
    );
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
    ['a lint finding', { outputs: { lint: { status: 1 } } }, 'preflight'],
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
        assert.match(stopStep(envelope).detail, detail);
      }
      assert.equal(h.blocks.length, 0, 'no label is written');
    });
  }

  test('a non-ratchet preflight finding quotes its failure rows and keeps the evidence path (#5968 AC-1)', async () => {
    const h = harness({
      outputs: {
        lint: {
          status: 1,
          stdout:
            'src/a.js:3:1 lint/style/useConst ━━━━━━\nFound 1 error.\n[run-lint] ✗ biome exited 1',
        },
        'quality-preview.js': {
          status: 1,
          stdout:
            '| file | MI delta | worst CRAP delta | n |\n| --- | --- | --- | --- |\n| src/a.js | -2.00 | +0.00 | 0 |',
        },
      },
    });
    const { envelope } = await h.run();
    const [lint, preview] = stopStep(envelope).findings;
    assert.equal(
      lint.detail,
      'lint finding: src/a.js:3:1 lint/style/useConst; Found 1 error.; ✗ biome exited 1 — fix and commit, then re-run',
    );
    assert.ok(lint.evidencePath);
    assert.equal(
      preview.detail,
      'quality-preview finding: | src/a.js | -2.00 | +0.00 | 0 | — fix and commit, then re-run',
    );
  });

  test('a non-ratchet preflight finding with no parsed row keeps the fixed text (#5968 AC-1)', async () => {
    const h = harness({ outputs: { lint: { status: 1, stdout: 'boom' } } });
    const { envelope } = await h.run();
    assert.equal(
      stopStep(envelope).detail,
      'lint finding — fix and commit, then re-run',
    );
  });

  test('lint and quality-preview both failing → one fix-required naming each, no suite', async () => {
    const h = harness({
      outputs: {
        lint: { status: 1 },
        'quality-preview.js': { status: 1 },
      },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'preflight');
    const step = stopStep(envelope);
    assert.deepEqual(
      step.findings.map((f) => f.check),
      ['lint', 'quality-preview'],
    );
    assert.deepEqual(
      step.detail.split('\n'),
      step.findings.map((f) => f.detail),
    );
    assert.ok(step.findings.every((f) => f.evidencePath));
    assert.notEqual(
      step.findings[0].evidencePath,
      step.findings[1].evidencePath,
    );
    assert.equal(envelope.evidencePath, step.findings[0].evidencePath);
    assert.ok(!spawned(h.runCommand).includes('coverage-capture.js'));
  });

  test('a re-run at the same HEAD repeats preflight after a finding, skips it after a clean pass', async () => {
    const outputs = { 'quality-preview.js': { status: 1 } };
    const h = harness({ outputs });
    await h.run();
    const statePath = path.join(
      tempRoot,
      'orchestration',
      `story-handoff-${STORY}.json`,
    );
    const { state } = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.preflightCredits.lint.head, HEAD, 'lint still credited');
    assert.equal(state.preflightHead, undefined);
    const firstSpawns = h.runCommand.calls.length;
    delete outputs['quality-preview.js'];
    const second = await h.run();
    const preflightSpawns = h.runCommand.calls
      .slice(firstSpawns)
      .map((c) => c.key)
      .filter((k) => ['typecheck', 'lint', 'quality-preview.js'].includes(k));
    assert.deepEqual(preflightSpawns, [
      'typecheck',
      'lint',
      'quality-preview.js',
    ]);
    assert.equal(second.envelope.status, 'ready');
    const third = await h.run();
    const pf = third.envelope.steps.find((s) => s.name === 'preflight');
    assert.equal(pf.outcome, 'skipped');
  });

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
    assert.deepEqual(stepNames(envelope), ['base-merge']);
    assert.deepEqual(spawned(h.runCommand), [], 'no preflight check spawns');
    assert.equal(h.blocks.length, 0);
  });

  test('an unclassified merge failure is fix-required with its stderr', async () => {
    const h = harness({
      sync: { synced: false, kind: 'merge-failed', stderr: 'boom ' },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'base-merge');
    assert.equal(stopStep(envelope).detail, 'merge failed: boom');
    assert.deepEqual(spawned(h.runCommand), []);
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

describe('story-handoff — a ruleset-evaluation push failure is retried stepped (Story #5965)', () => {
  const RULESET = {
    status: 1,
    stdout:
      'remote: fatal error in commit_refs_rules\n ! [remote rejected] story-5518 -> story-5518 (failure)',
  };
  const shas = (n) =>
    Array.from({ length: n }, (_, i) => `${i + 1}`.repeat(40));
  const range = (n) => [...shas(n - 1), HEAD];
  const pushes = (h) =>
    h.runCommand.calls.filter((c) => c.key === 'git').map((c) => c.args);
  const steppedRun = (n, git, worldOpts = {}) =>
    harness({
      world: gitWorld({ firstParent: range(n), ...worldOpts }),
      outputs: { git },
    });

  test('AC-1/AC-2: steps every 3rd first-parent commit, then the branch, and settles ready', async () => {
    const h = steppedRun(8, [RULESET]);
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.status, 'ready');
    const push = envelope.steps.find((s) => s.name === 'push');
    assert.equal(push.outcome, 'ran');
    assert.match(push.detail, /stepped push of 3 step\(s\)/);
    const s = shas(7);
    assert.deepEqual(pushes(h), [
      ['push', '-u', 'origin', `story-${STORY}`],
      ['push', 'origin', `${s[2]}:refs/heads/story-${STORY}`],
      ['push', 'origin', `${s[5]}:refs/heads/story-${STORY}`],
      ['push', '-u', 'origin', `story-${STORY}`],
    ]);
    assert.equal(h.blocks.length, 0, 'no label or friction');
  });

  test('AC-2: a range of 3 or fewer pushes each commit before HEAD', async () => {
    const h = steppedRun(3, [RULESET]);
    const { exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.deepEqual(
      pushes(h)
        .slice(1, -1)
        .map((a) => a[2]),
      shas(2).map((sha) => `${sha}:refs/heads/story-${STORY}`),
    );
  });

  test('AC-2: the range excludes the base and the existing remote tip', async () => {
    const tip = 'c'.repeat(40);
    const h = steppedRun(2, [RULESET], { remote: tip });
    await h.run();
    const revList = h.world.calls.find((a) => a[0] === 'rev-list');
    assert.deepEqual(revList, [
      'rev-list',
      '--first-parent',
      '--reverse',
      'HEAD',
      '^origin/main',
      `^${tip}`,
    ]);
  });

  test('AC-2/AC-3: every push has its own evidence log and none skips hooks', async () => {
    const h = steppedRun(5, [RULESET]);
    await h.run();
    const dir = path.join(tempRoot, 'orchestration');
    for (const log of ['push', 'push-step-1', 'push-step-2']) {
      assert.ok(
        existsSync(path.join(dir, `story-handoff-${STORY}-${log}.log`)),
        log,
      );
    }
    for (const args of pushes(h)) {
      assert.ok(!args.some((a) => /no-verify|^-n$/.test(a)), args.join(' '));
    }
  });

  test('AC-3: a stepped push the remote does not confirm is blocked push-unconfirmed', async () => {
    const kept = { status: 0, keepRemote: true };
    const h = steppedRun(2, [RULESET, kept, kept]);
    h.world.remote = null;
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 1);
    assert.equal(envelope.reason, 'push-unconfirmed');
  });

  test('AC-4: a step failing again with the ruleset error is fix-required with the recipe', async () => {
    const h = steppedRun(5, [RULESET, { status: 0 }, RULESET]);
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.status, 'fix-required');
    assert.equal(envelope.reason, 'ruleset-eval-failed');
    assert.match(envelope.evidencePath, /push-step-2\.log$/);
    const detail = stopStep(envelope).detail;
    for (const sha of range(5)) {
      assert.ok(
        detail.includes(`git push origin ${sha}:refs/heads/story-${STORY}`),
      );
    }
    assert.equal(h.blocks.length, 0, 'no label or friction');
  });

  const otherFailures = [
    [
      'a hook decline',
      ' ! [remote rejected] story-5518 -> story-5518 (pre-receive hook declined)',
      1,
      'blocked',
    ],
    [
      'a non-fast-forward',
      ' ! [rejected]        story-5518 -> story-5518 (non-fast-forward)',
      2,
      'fix-required',
    ],
  ];
  for (const [label, stdout, code, status] of otherFailures) {
    test(`AC-5: a step failing with ${label} routes as a first attempt would`, async () => {
      const h = steppedRun(2, [RULESET, { status: 1, stdout }]);
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, code);
      assert.equal(envelope.status, status);
      if (status === 'blocked') assert.equal(envelope.reason, 'push-rejected');
    });
  }

  test('AC-6: a remote tip that is not an ancestor of HEAD attempts no stepped push', async () => {
    const h = steppedRun(4, [RULESET], {
      remote: 'c'.repeat(40),
      ancestor: false,
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.match(
      stopStep(envelope).detail,
      /git fetch origin story-\d+, git merge origin\/story-\d+/,
    );
    assert.equal(pushes(h).length, 1);
  });

  const unchanged = [
    [' ! [remote rejected] story-5518 -> story-5518 (declined)', 1],
    ['fatal: unable to access: The requested URL returned error: 403', 1],
    ['fatal: Could not read from remote repository.', 1],
    [' ! [rejected]        story-5518 -> story-5518 (fetch first)', 2],
    ['husky - pre-push script failed', 2],
  ];
  for (const [stdout, code] of unchanged) {
    test(`AC-7: without the ruleset text no retry spawns (${stdout.trim().slice(0, 30)})`, async () => {
      const h = steppedRun(4, [{ status: 1, stdout }]);
      const { exitCode } = await h.run();
      assert.equal(exitCode, code);
      assert.equal(pushes(h).length, 1);
      assert.ok(!h.world.calls.some((a) => a[0] === 'rev-list'));
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
    const h = harness({ outputs: { lint: { status: 1 } } });
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
    const { runCommand, syncFromBase, computeReview, runDuplicationRescore } =
      h.deps;
    h.deps.runDuplicationRescore = async (...args) => {
      peek();
      return runDuplicationRescore(...args);
    };
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
    // Story #5905: the review computes during the credited run; the record
    // still names the review phase while the handoff awaits it.
    assert.deepEqual(observed, stepNames(envelope).slice(0, -1));
    peek();
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
    // Each run counts as one more handoff attempt; nothing else may differ.
    assert.deepEqual(
      { ...blocked.envelope, attempt: 1 },
      { ...baseline.envelope, attempt: 1 },
    );
  });
});

/**
 * Story #5662 — the credited run's lock state streams live. The child writes
 * structured `lock-progress` events to the channel the handoff opened; the
 * handoff tails it while the child runs and forwards each event once as a
 * `LOCK` progress line. Child output is never read for lock state.
 */
describe('story-handoff — live lock progress for the credited run (Story #5662)', () => {
  const CHANNEL_ENV = 'MANDREL_CLOSE_LOCK_EVENTS_FILE';
  const HOLDER = { ownerId: 'pid-77-1', pid: 77, ageSeconds: 40 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const progressEvent = (phase, waitedSeconds, extra = {}) => ({
    kind: 'lock-progress',
    phase,
    waitedSeconds,
    waitBudgetSeconds: 300,
    ...extra,
  });

  /**
   * Wraps the harness's command double: the credited run plays `script`
   * against the channel file from its env before resolving.
   */
  function liveHarness(script, options = {}) {
    const h = harness(options);
    const lines = [];
    const envs = [];
    h.deps.progress = (tag, msg) => lines.push({ tag, msg });
    h.deps.sleep = tick;
    h.deps.lockPollMs = 0;
    h.deps.env = { PARENT_ONLY: 'kept' };
    h.deps.runCommand = async (cmd, args, opts = {}) => {
      envs.push({ key: path.basename(args[0] ?? cmd), env: opts.env });
      if (path.basename(args[0] ?? '') !== 'coverage-capture.js') {
        return h.runCommand(cmd, args, opts);
      }
      const file = opts.env?.[CHANNEL_ENV];
      const emit = (event) =>
        writeFileSync(file, `${JSON.stringify(event)}\n`, { flag: 'a' });
      const result = await script({ emit, lines, file });
      return { stderr: '', ...result };
    };
    const lockLines = () =>
      lines.filter((l) => l.tag === 'LOCK').map((l) => l.msg);
    const waitForLock = async (count) => {
      for (let i = 0; i < 200 && lockLines().length < count; i += 1) {
        await tick();
      }
      return lockLines();
    };
    return { ...h, lines, envs, lockLines, waitForLock };
  }

  test('AC-1/AC-2/AC-3: waiting, still-waiting and acquired stream before the child exits, each once, in order', async () => {
    const seenWhileRunning = [];
    let channelFile;
    const h = liveHarness(async ({ emit, file }) => {
      channelFile = file;
      emit(progressEvent('waiting', 0, { holder: HOLDER, queueAhead: 1 }));
      seenWhileRunning.push([...(await h.waitForLock(1))]);
      emit(
        progressEvent('still-waiting', 25, { holder: HOLDER, queueAhead: 0 }),
      );
      seenWhileRunning.push([...(await h.waitForLock(2))]);
      emit(progressEvent('acquired', 31));
      seenWhileRunning.push([...(await h.waitForLock(3))]);
      return {
        status: 0,
        stdout: [
          '[full-suite-lock] ⏳ another full suite is already running on this host',
          '[full-suite-lock] ✅ acquired the full-suite lock (waited 31s).',
          '[coverage-capture] Wrote content-digest capture stamp.',
        ].join('\n'),
        stderr: 'suite stderr line',
      };
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(seenWhileRunning[0].length, 1, 'waiting shown mid-run');
    assert.match(
      seenWhileRunning[0][0],
      /^waiting for the full-suite lock \(waited 0s of a 300s budget; holder pid-77-1, pid 77, lock age 40s; 1 ahead in queue\)$/,
    );
    assert.equal(seenWhileRunning[1].length, 2, 'still-waiting shown mid-run');
    assert.match(
      seenWhileRunning[1][1],
      /^still waiting for the full-suite lock \(waited 25s of a 300s budget; holder pid-77-1, pid 77, lock age 40s; 0 ahead in queue\)$/,
    );
    assert.equal(seenWhileRunning[2].length, 3, 'acquired shown mid-run');
    const final = h.lockLines();
    assert.equal(final.length, 3, 'each event forwarded exactly once');
    assert.match(
      final[2],
      /^acquired the full-suite lock \(waited 31s of a 300s budget\)$/,
    );
    // AC-4: the evidence log still holds the child's whole combined output.
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    const evidence = readFileSync(credited.evidencePath, 'utf8');
    assert.equal(
      evidence,
      [
        '[full-suite-lock] ⏳ another full suite is already running on this host',
        '[full-suite-lock] ✅ acquired the full-suite lock (waited 31s).',
        '[coverage-capture] Wrote content-digest capture stamp.',
        'suite stderr line',
      ].join('\n'),
    );
    // The child got the parent env plus the channel; nothing else did.
    const creditedEnv = h.envs.find((e) => e.key === 'coverage-capture.js');
    assert.equal(creditedEnv.env.PARENT_ONLY, 'kept');
    assert.equal(creditedEnv.env[CHANNEL_ENV], channelFile);
    assert.ok(
      h.envs
        .filter((e) => e.key !== 'coverage-capture.js')
        .every((e) => e.env[CHANNEL_ENV] === undefined),
      'only the credited run opens a channel',
    );
    assert.throws(() => readFileSync(channelFile), /ENOENT/, 'disposed');
  });

  test('AC-3: an expiry streams its LOCK line and keeps the exit-75 guidance', async () => {
    const h = liveHarness(async ({ emit }) => {
      emit(progressEvent('waiting', 0, { holder: HOLDER }));
      emit(progressEvent('expired', 300, { holder: HOLDER, queueAhead: 0 }));
      return { status: 75, stdout: '[full-suite-lock] ⌛ gave up waiting' };
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.status, 'fix-required');
    const lock = h.lockLines();
    assert.equal(lock.length, 2);
    assert.match(
      lock[1],
      /^gave up waiting for the full-suite lock \(waited 300s of a 300s budget; holder pid-77-1, pid 77, lock age 40s; 0 ahead in queue\)$/,
    );
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(
      credited.detail,
      'suite deferred (exit 75): another full suite holds the host lock — re-run the handoff once it frees',
    );
  });

  test('Story #5668: queued, admitted and completed render the blocking reason and split durations', async () => {
    const h = liveHarness(async ({ emit }) => {
      emit(
        progressEvent('waiting', 0, {
          blocking: { reason: 'capacity', used: 8, requested: 4, capacity: 10 },
        }),
      );
      emit(progressEvent('admitted', 12));
      emit(
        progressEvent('completed', 12, { waitMs: 12_000, executionMs: 13_466 }),
      );
      return {
        status: 0,
        stdout: '[coverage-capture] Wrote content-digest capture stamp.',
      };
    });
    await h.run();
    assert.deepEqual(h.lockLines(), [
      'waiting for the full-suite lock (waited 0s of a 300s budget; blocked: capacity 8/10 in use, 4 requested)',
      'admitted — suite running (waited 12s of a 300s budget)',
      'suite completed (waited 12s, ran 13s)',
    ]);
  });

  test('Story #5668: an exit-78 refusal says the declaration is wrong, not the suite', async () => {
    const h = liveHarness(async () => ({ status: 78, stdout: '' }));
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    assert.match(
      credited.detail,
      /^suite refused \(exit 78\): .*exceeds capacity/,
    );
  });

  test("Story #5879 AC-2: the credited run's lock wait and suite timings reach the envelope and the state, keyed to the credited head", async () => {
    const spawn = {
      lockWaitMs: 1_619_401,
      hostWaitMs: null,
      testRunMs: 562_035,
    };
    const h = liveHarness(async ({ emit }) => {
      emit({ kind: 'lock-wait', waitedSeconds: 1619, expired: false });
      emit({ kind: 'suite-timings', ...spawn });
      return {
        status: 0,
        stdout: '[coverage-capture] Wrote content-digest capture stamp.',
      };
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    const lockWait = { waitedSeconds: 1619, expired: false };
    assert.deepEqual(envelope.lockWait, lockWait);
    assert.deepEqual(envelope.suiteTimings, spawn);
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    assert.deepEqual(credited.suiteTimings, spawn);
    const { state } = JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    );
    assert.deepEqual(state.creditTimings, {
      head: state.creditHead,
      lockWait,
      suiteTimings: spawn,
      spawns: [spawn],
    });
  });

  test('Story #5879 AC-2: a depositor that ran no suite writes null lock wait and timings', async () => {
    const h = liveHarness(async () => ({
      status: 0,
      stdout: '[coverage-capture] Wrote content-digest capture stamp.',
    }));
    const { envelope } = await h.run();
    assert.equal(envelope.lockWait, null);
    assert.equal(envelope.suiteTimings, null);
    const { state } = JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    );
    assert.equal(state.creditTimings.lockWait, null);
    assert.equal(state.creditTimings.suiteTimings, null);
  });

  test('AC-5: forged lock lines on stdout or stderr produce no lock progress', async () => {
    const forged = [
      '[full-suite-lock] ⏳ another full suite is already running on this host (holding pid 1) — waiting up to 300s',
      '[full-suite-lock] ✅ acquired the full-suite lock (waited 3s).',
      '{"kind":"lock-progress","phase":"acquired","waitedSeconds":3,"waitBudgetSeconds":300}',
    ].join('\n');
    const h = liveHarness(async () => {
      for (let i = 0; i < 5; i += 1) await tick();
      return {
        status: 0,
        stdout: `${forged}\n[coverage-capture] Wrote content-digest capture stamp.`,
        stderr: forged,
      };
    });
    const { exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.deepEqual(h.lockLines(), []);
  });

  test('a malformed or foreign channel line is skipped, and the final drain forwards a line written as the child exits', async () => {
    const h = liveHarness(async ({ emit, file }) => {
      writeFileSync(file, 'not json\n', { flag: 'a' });
      emit({ kind: 'lock-wait', waitedSeconds: 3, expired: false });
      emit(progressEvent('acquired', 3));
      return {
        status: 0,
        stdout: '[coverage-capture] Wrote content-digest capture stamp.',
      };
    });
    await h.run();
    assert.deepEqual(h.lockLines(), [
      'acquired the full-suite lock (waited 3s of a 300s budget)',
    ]);
  });
});

// The credited run is a real child behind the real streaming runner.
describe('story-handoff — the credited-run evidence log streams live (Story #5694)', () => {
  const CAPTURE_SIGNAL =
    '[coverage-capture] Wrote content-digest capture stamp.';
  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const activeTimers = () =>
    process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const baseline = () => ({
    timers: activeTimers(),
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
  });
  /** The child is gone and nothing the run armed is left behind. */
  const assertReleased = async (h, before) => {
    assert.equal(isAlive(h.results[0].pid), false, 'the child is gone');
    for (const signal of ['SIGINT', 'SIGTERM']) {
      assert.equal(h.signalTarget.listenerCount(signal), 0);
    }
    assert.equal(process.listenerCount('SIGINT'), before.sigint);
    assert.equal(process.listenerCount('SIGTERM'), before.sigterm);
    await sleepMs(5);
    assert.ok(activeTimers() <= before.timers, 'no timer outlives the run');
  };

  const gatedChild = (goFile, before, after, exitCode = 0) =>
    [
      'const fs = require("node:fs");',
      `process.stdout.write(${JSON.stringify(before)});`,
      'const t = setInterval(() => {',
      `  if (!fs.existsSync(${JSON.stringify(goFile)})) return;`,
      '  clearInterval(t);',
      `  process.stdout.write(${JSON.stringify(after)});`,
      `  process.exitCode = ${exitCode};`,
      '}, 10);',
    ].join('\n');

  function streamHarness(script, options = {}) {
    const h = harness(options);
    const lines = [];
    const results = [];
    const signalTarget = new EventEmitter();
    const reraised = [];
    h.deps.progress = (tag, msg) => lines.push({ tag, msg });
    h.deps.sleep = () => new Promise((resolve) => setImmediate(resolve));
    h.deps.lockPollMs = 0;
    h.deps.signalTarget = signalTarget;
    h.deps.reraise = (signal) => reraised.push(signal);
    h.deps.runCommand = async (cmd, args, opts = {}) => {
      if (path.basename(args[0] ?? '') !== 'coverage-capture.js') {
        return h.runCommand(cmd, args, opts);
      }
      const res = await spawnStreamAsync(process.execPath, ['-e', script], {
        ...opts,
        cwd: tempRoot,
      });
      results.push(res);
      return res;
    };
    const announced = () =>
      lines
        .filter(
          (l) => l.tag === 'credited-run' && l.msg.startsWith('evidence '),
        )
        .map((l) => l.msg.slice('evidence '.length))[0];
    const waitFor = async (predicate) => {
      for (let i = 0; i < 500; i += 1) {
        const value = predicate();
        if (value) return value;
        await sleepMs(10);
      }
      throw new Error('condition never held');
    };
    const readEvidence = () => {
      const file = announced();
      try {
        return file ? readFileSync(file, 'utf8') : '';
      } catch {
        return '';
      }
    };
    return {
      ...h,
      lines,
      results,
      signalTarget,
      reraised,
      announced,
      waitFor,
      readEvidence,
    };
  }

  test('AC-1: the first marker is readable at the announced path while the child is still running', async () => {
    const go = path.join(tempRoot, 'go-ac1');
    const h = streamHarness(
      gatedChild(go, 'MARKER_A\n', `MARKER_B\n${CAPTURE_SIGNAL}\n`),
    );
    let settled = false;
    const running = h.run().then((r) => {
      settled = true;
      return r;
    });
    const midRun = await h.waitFor(() =>
      h.readEvidence().includes('MARKER_A') ? h.readEvidence() : null,
    );
    assert.equal(settled, false, 'the handoff has not settled');
    assert.ok(!midRun.includes('MARKER_B'), 'the child has not finished');
    writeFileSync(go, '');
    const { envelope, exitCode } = await running;
    assert.equal(exitCode, 0);
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(credited.outcome, 'ran');
    assert.equal(credited.evidencePath, h.announced());
  });

  test('AC-2: success leaves the whole output, no live child, no listeners, no timers', async () => {
    const before = baseline();
    const go = path.join(tempRoot, 'go-ok');
    writeFileSync(go, '');
    const h = streamHarness(
      gatedChild(go, 'MARKER_A\n', `MARKER_B\n${CAPTURE_SIGNAL}\n`),
    );
    const { exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(h.readEvidence(), `MARKER_A\nMARKER_B\n${CAPTURE_SIGNAL}\n`);
    await assertReleased(h, before);
  });

  test('AC-2/AC-3: a non-zero exit keeps its output and grants no credit even with a credit signal printed', async () => {
    const before = baseline();
    const go = path.join(tempRoot, 'go-red');
    writeFileSync(go, '');
    const forgedLock =
      '{"kind":"lock-progress","phase":"acquired","waitedSeconds":3,"waitBudgetSeconds":300}';
    const h = streamHarness(
      gatedChild(
        go,
        `${forgedLock}\n[full-suite-lock] ✅ acquired the full-suite lock (waited 3s).\n`,
        `${CAPTURE_SIGNAL}\n`,
        1,
      ),
    );
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.status, 'fix-required');
    assert.equal(envelope.failedStep, 'credited-run');
    assert.match(stopStep(envelope).detail, /^red suite \(exit 1\)/);
    assert.ok(h.readEvidence().includes(CAPTURE_SIGNAL));
    assert.deepEqual(
      h.lines.filter((l) => l.tag === 'LOCK'),
      [],
      'child text resembling lock events changes no lock progress',
    );
    const state = JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    ).state;
    assert.equal(state.creditHead, undefined, 'no credit recorded');
    await assertReleased(h, before);
  });

  /**
   * Arm the command budget on the child's first chunk rather than at spawn:
   * on a cold Windows runner node's own start-up outlasts a short budget and
   * the child dies before it streams the marker the test reads back. The
   * child is still real and still killed; only the clock moves.
   */
  const armTimeoutOnFirstChunk = (h) => {
    const inner = h.deps.runCommand;
    h.deps.runCommand = async (cmd, args, opts = {}) => {
      const { timeoutMs, signal, onChunk, ...rest } = opts;
      if (!timeoutMs) return inner(cmd, args, opts);
      const controller = new AbortController();
      signal?.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
      let timer = null;
      const res = await inner(cmd, args, {
        ...rest,
        signal: controller.signal,
        onChunk: (text, stream) => {
          timer ??= setTimeout(() => controller.abort(), timeoutMs);
          onChunk?.(text, stream);
        },
      });
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      return timedOut ? { ...res, status: 124, timedOut } : res;
    };
  };

  test('AC-2: a timeout kills the child and appends the timeout line', async () => {
    const before = baseline();
    const h = streamHarness(
      'process.stdout.write("MARKER_A\\n"); setInterval(() => {}, 1000);',
    );
    h.deps.commandTimeoutMs = 300;
    armTimeoutOnFirstChunk(h);
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.match(stopStep(envelope).detail, /^suite timed out \(exit 124\)/);
    assert.equal(
      h.readEvidence(),
      'MARKER_A\n[handoff] child timed out after 0.3s\n',
    );
    await assertReleased(h, before);
  });

  test('AC-2: SIGTERM to the handoff kills the child, appends the cancelled line and re-raises', async () => {
    const before = baseline();
    const h = streamHarness(
      'process.stdout.write("MARKER_A\\n"); setInterval(() => {}, 1000);',
    );
    const running = h.run();
    await h.waitFor(() => h.readEvidence().includes('MARKER_A'));
    h.signalTarget.emit('SIGTERM');
    const { envelope, exitCode } = await running;
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'credited-run');
    assert.equal(h.readEvidence(), 'MARKER_A\n[handoff] cancelled\n');
    assert.deepEqual(h.reraised, ['SIGTERM']);
    await assertReleased(h, before);
  });

  test('AC-4: a silent child gets elapsed heartbeats and the progress record carries phase and evidence path', async () => {
    const go = path.join(tempRoot, 'go-quiet');
    const h = streamHarness(gatedChild(go, '', `${CAPTURE_SIGNAL}\n`));
    h.deps.heartbeatMs = 20;
    const running = h.run();
    const heartbeat = /^running \d+s, last output \d+s ago$/;
    await h.waitFor(() =>
      h.lines.some((l) => l.tag === 'credited-run' && heartbeat.test(l.msg)),
    );
    const record = JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-progress-${STORY}.json`),
        'utf8',
      ),
    );
    assert.equal(record.phase, 'credited-run');
    assert.equal(record.evidencePath, h.announced());
    writeFileSync(go, '');
    const { exitCode } = await running;
    assert.equal(exitCode, 0);
    const creditedLines = h.lines
      .filter((l) => l.tag === 'credited-run')
      .map((l) => l.msg);
    assert.ok(
      creditedLines.every(
        (m) =>
          heartbeat.test(m) ||
          m.startsWith('evidence ') ||
          m.startsWith('node ') ||
          m.startsWith('ran — '),
      ),
      `no synthesised counts: ${creditedLines.join(' | ')}`,
    );
  });

  test('an evidence file that cannot be opened degrades to the completion-only write', async () => {
    const go = path.join(tempRoot, 'go-degrade');
    writeFileSync(go, '');
    const h = streamHarness(
      gatedChild(go, 'MARKER_A\n', `${CAPTURE_SIGNAL}\n`),
    );
    h.deps.evidenceFs = {
      openSync: () => {
        throw new Error('EACCES');
      },
      writeFileSync,
    };
    const { exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(h.readEvidence(), `MARKER_A\n${CAPTURE_SIGNAL}`);
  });
});

/**
 * Story #5905 — the held review starts with the credited run, and a CRITICAL
 * that lands mid-run aborts the run instead of waiting it out.
 */
describe('story-handoff — the review runs beside the credited run (Story #5905)', () => {
  const HALTED = { halted: true, severity: { critical: 1 } };
  const readState = () =>
    JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    ).state;

  test('AC-1: the review is in flight while the credited run is in flight', async () => {
    const h = harness();
    const review = { started: false, settled: false };
    let overlapped = false;
    const { runCommand, computeReview } = h.deps;
    h.deps.computeReview = async (input) => {
      review.started = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      review.settled = true;
      return computeReview(input);
    };
    h.deps.runCommand = async (cmd, args, opts) => {
      if (path.basename(args[0] ?? '') === 'coverage-capture.js') {
        overlapped = review.started && !review.settled;
      }
      return runCommand(cmd, args, opts);
    };
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.equal(
      overlapped,
      true,
      'the review was running when the suite spawned',
    );
    assert.equal(review.settled, true);
  });

  test('AC-2: a CRITICAL mid-run aborts the child, credits nothing, pushes nothing and frees the lock', async () => {
    const lockPath = path.join(tempRoot, 'full-suite.lock');
    const h = harness({ deposit: HALTED });
    let childStarted;
    const started = new Promise((resolve) => {
      childStarted = resolve;
    });
    let heldDuringRun = false;
    const { runCommand, computeReview } = h.deps;
    h.deps.computeReview = async (input) => {
      await started;
      return computeReview(input);
    };
    h.deps.runCommand = async (cmd, args, opts) => {
      if (path.basename(args[0] ?? '') !== 'coverage-capture.js') {
        return runCommand(cmd, args, opts);
      }
      return withFullSuiteLockAsync({ cwd: tempRoot, lockPath }, () =>
        spawnStreamAsync(
          process.execPath,
          [
            '-e',
            'process.stdout.write("RUNNING\\n"); setInterval(() => {}, 1000);',
          ],
          {
            ...opts,
            cwd: tempRoot,
            onChunk: (text) => {
              opts.onChunk(text);
              heldDuringRun = existsSync(lockPath);
              childStarted();
            },
          },
        ),
      );
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.status, 'fix-required');
    assert.equal(envelope.failedStep, 'review');
    assert.equal(envelope.evidencePath, '/tmp/story-review.json');
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(credited.outcome, 'aborted');
    assert.match(readFileSync(credited.evidencePath, 'utf8'), /aborted\n$/);
    assert.deepEqual(stepNames(envelope).slice(-2), ['credited-run', 'review']);
    assert.ok(!spawned(h.runCommand).includes('git'), 'nothing was pushed');
    assert.equal(h.world.remote, null);
    assert.equal(readState().creditHead, undefined, 'no credit recorded');
    assert.equal(heldDuringRun, true, 'the child held the lock');
    assert.equal(existsSync(lockPath), false, 'the lock is free afterwards');
  });

  test('AC-3: a run that finishes first awaits the review and settles as the sequential order did', async () => {
    const h = harness({ deposit: HALTED });
    let runDone;
    const done = new Promise((resolve) => {
      runDone = resolve;
    });
    const { runCommand, computeReview } = h.deps;
    h.deps.runCommand = async (cmd, args, opts) => {
      const res = await runCommand(cmd, args, opts);
      if (path.basename(args[0] ?? '') === 'coverage-capture.js') runDone();
      return res;
    };
    h.deps.computeReview = async (input) => {
      await done;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return computeReview(input);
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'review');
    assert.deepEqual(stepNames(envelope), [
      'base-merge',
      'duplication-rescore',
      'seat-static',
      'preflight',
      'credited-run',
      'seat',
      'post-capture',
      'push',
      'review',
    ]);
    assert.equal(envelope.steps[3].outcome, 'ran');
    assert.equal(
      readState().creditHead,
      HEAD,
      'the finished run keeps its credit',
    );
  });

  test('AC-5: the envelope reports the review duration beside the suite timings', async () => {
    const h = harness();
    let t = 1_000;
    h.deps.now = () => {
      t += 250;
      return t;
    };
    const { envelope } = await h.run();
    assert.ok(Number.isInteger(envelope.reviewMs) && envelope.reviewMs > 0);
    assert.equal(reviewStep(envelope).durationMs, envelope.reviewMs);
    assert.ok('suiteTimings' in envelope);
  });

  test('a stop before the review settles still awaits it, so no provider is orphaned', async () => {
    const h = harness({ outputs: { 'coverage-capture.js': { status: 1 } } });
    let settled = false;
    const { computeReview } = h.deps;
    h.deps.computeReview = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      settled = true;
      return computeReview(input);
    };
    const { envelope } = await h.run();
    assert.equal(envelope.failedStep, 'credited-run');
    assert.equal(settled, true);
    assert.deepEqual(stepNames(envelope).slice(-2), ['credited-run', 'review']);
  });
});

describe('story-handoff — the review starts at base-merge (Story #5966)', () => {
  const HALTED = { halted: true, severity: { critical: 1 } };
  const MERGED = 'c'.repeat(40);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const readState = () =>
    JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    ).state;
  /** Records each probe's pinned sha; the merge moves HEAD to MERGED. */
  function mergingHarness(opts = {}) {
    const h = harness(opts);
    const shas = [];
    h.deps.syncFromBase = async () => {
      h.world.head = MERGED;
      return { synced: true, kind: 'merge-commit', changedPaths: ['x.js'] };
    };
    h.deps.probeReview = ({ sha }) => {
      shas.push(sha);
      return { deposit: null };
    };
    return { ...h, shas };
  }
  /** Delays the lint spawn and reports whether `busy()` held while it ran. */
  function slowLint(h, busy) {
    const { runCommand } = h.deps;
    const seen = { during: false };
    h.deps.runCommand = async (cmd, args, opts) => {
      if (commandKey(cmd, args) === 'lint') {
        await delay(20);
        seen.during = busy();
      }
      return runCommand(cmd, args, opts);
    };
    return seen;
  }

  test('AC-1: the provider is called while preflight is in flight, pinned to the post-merge HEAD', async () => {
    const h = mergingHarness();
    const review = { started: false, settled: false };
    const { computeReview } = h.deps;
    h.deps.computeReview = async (input) => {
      review.started = true;
      await delay(5);
      review.settled = true;
      return computeReview(input);
    };
    let startedBeforePreflight = null;
    const { runCommand } = h.deps;
    h.deps.runCommand = async (cmd, args, opts) => {
      startedBeforePreflight ??= review.started;
      return runCommand(cmd, args, opts);
    };
    const seen = slowLint(h, () => review.settled);
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.equal(startedBeforePreflight, true, 'in flight before any check');
    assert.equal(seen.during, true, 'settled while lint was still running');
    assert.deepEqual(h.shas, [MERGED]);
    assert.equal(h.reviews.length, 1);
  });

  test('AC-2: no review starts on a precheck refusal or any non-synced base-merge', async () => {
    const syncs = [
      { synced: false, kind: 'conflict', conflictFiles: ['a.js'] },
      { synced: false, kind: 'fetch-failed', stderr: 'offline' },
      { synced: false, kind: 'merge-driver-missing', stderr: 'no driver' },
      { synced: false, kind: 'other', stderr: 'boom' },
    ];
    for (const sync of syncs) {
      const h = harness({ sync });
      let probed = false;
      h.deps.probeReview = () => {
        probed = true;
        return { deposit: null };
      };
      const { envelope } = await h.run();
      assert.equal(envelope.failedStep, 'base-merge', sync.kind);
      assert.equal(probed, false, `${sync.kind}: never probed`);
      assert.equal(h.reviews.length, 0, `${sync.kind}: provider never called`);
      assert.deepEqual(stepNames(envelope), ['base-merge']);
    }
    const world = gitWorld();
    world.dirty = ['src/a.js'];
    const refused = harness({ world });
    await refused.run();
    assert.equal(refused.reviews.length, 0);
  });

  for (const [depositor, scripts] of [
    ['coverage-capture', CAPTURE_SCRIPTS],
    ['test', { test: 'x' }],
  ]) {
    test(`AC-3: a review halted before the run stops the ${depositor} handoff with no seat, run, lock, credit or push`, async () => {
      const h = harness({ deposit: HALTED, scripts });
      let channels = 0;
      h.deps.createLockChannel = () => {
        channels += 1;
        return createLockEventChannel();
      };
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 2);
      assert.equal(envelope.status, 'fix-required');
      assert.equal(envelope.failedStep, 'review');
      assert.equal(envelope.evidencePath, '/tmp/story-review.json');
      assert.deepEqual(stepNames(envelope), [
        'base-merge',
        'duplication-rescore',
        'seat-static',
        'preflight',
        'review',
      ]);
      const keys = spawned(h.runCommand);
      for (const key of [
        'coverage-capture.js',
        'evidence-gate.js',
        'update-crap-baseline.js',
        'update-coverage-baseline.js',
        'git',
      ]) {
        assert.ok(!keys.includes(key), `${key} never spawns`);
      }
      assert.equal(channels, 0, 'no lock is queued or held');
      assert.equal(readState().creditHead, undefined, 'no credit recorded');
      assert.equal(h.world.remote, null, 'nothing pushed');
    });
  }

  test('AC-4: a preflight finding and a halted review settle as one envelope naming preflight', async () => {
    const h = harness({
      deposit: HALTED,
      outputs: { lint: { status: 1, stdout: 'lint finding' } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.status, 'fix-required');
    assert.equal(envelope.failedStep, 'preflight');
    const preflight = envelope.steps.find((s) => s.name === 'preflight');
    const review = envelope.steps.find((s) => s.name === 'review');
    assert.equal(preflight.outcome, 'failed');
    assert.equal(review.outcome, 'failed');
    assert.ok(preflight.evidencePath, 'preflight names its evidence');
    assert.equal(review.evidencePath, '/tmp/story-review.json');
    assert.equal(envelope.evidencePath, preflight.evidencePath);
    assert.equal(stepNames(envelope).at(-1), 'review');
  });

  test('AC-5: a CRITICAL settling mid-preflight leaves every preflight check to run', async () => {
    const h = harness({ deposit: HALTED });
    let halted = false;
    const { computeReview } = h.deps;
    h.deps.computeReview = async (input) => {
      const out = await computeReview(input);
      halted = true;
      return out;
    };
    const seen = slowLint(h, () => halted);
    const { envelope } = await h.run();
    assert.equal(seen.during, true, 'the review halted while lint ran');
    const preflight = envelope.steps.find((s) => s.name === 'preflight');
    assert.equal(preflight.outcome, 'ran');
    const keys = spawned(h.runCommand);
    assert.ok(keys.includes('lint'));
    assert.ok(keys.includes('quality-preview.js'), 'later checks still ran');
    assert.equal(envelope.failedStep, 'review');
  });

  test('AC-7: a review error after a stop is recorded once and stays non-blocking', async () => {
    const h = harness({
      outputs: { lint: { status: 1, stdout: 'lint finding' } },
    });
    h.deps.computeReview = async () => {
      throw new Error('provider down');
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'preflight');
    assert.equal(
      envelope.steps.filter((s) => s.name === 'review').length,
      1,
      'recorded once',
    );
    assert.equal(envelope.steps.at(-1).outcome, 'error');
  });

  test('AC-7: a halted review appended after a blocked stop leaves the status blocked', async () => {
    const h = harness({
      deposit: HALTED,
      world: gitWorld({ lsRemoteFails: true }),
    });
    let runDone;
    const done = new Promise((resolve) => {
      runDone = resolve;
    });
    const { runCommand, computeReview } = h.deps;
    h.deps.runCommand = async (cmd, args, opts) => {
      const res = await runCommand(cmd, args, opts);
      if (path.basename(args[0] ?? '') === 'coverage-capture.js') runDone();
      return res;
    };
    h.deps.computeReview = async (input) => {
      await done;
      await delay(10);
      return computeReview(input);
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 1);
    assert.equal(envelope.status, 'blocked');
    assert.equal(envelope.failedStep, 'push');
    assert.deepEqual(stepNames(envelope).slice(-2), ['push', 'review']);
    assert.equal(envelope.steps.at(-1).outcome, 'failed');
  });

  test('AC-8: on the test depositor the review is computed once against the pre-seat head', async () => {
    const h = mergingHarness({
      scripts: { test: 'x' },
      outputs: {
        'update-crap-baseline.js': { status: 0, stdout: 'seated: 1' },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.equal(envelope.headSha, SEATED_HEAD, 'the seat committed');
    assert.deepEqual(h.shas, [MERGED]);
    assert.equal(
      h.reviews.length,
      1,
      'the seat commit starts no second review',
    );
    assert.equal(envelope.steps.filter((s) => s.name === 'review').length, 1);
  });
});

describe('story-handoff — close-identity deposits and post-capture scoring (Story #5937)', () => {
  const lintHash = hashCommandConfig({
    cmd: 'npm',
    args: ['run', 'lint'],
    cwd: '/work',
  });
  const typecheckHash = hashCommandConfig({
    cmd: 'npm',
    args: ['run', 'typecheck'],
    cwd: '/work',
  });
  const callFor = (h, key) => h.runCommand.calls.find((c) => c.key === key);
  const evidenceSkip = (gateName, sha, configHash) =>
    shouldSkip(
      { storyId: STORY, gateName, currentSha: sha, configHash },
      { cwd: tempRoot, standalone: true },
    );
  const readState = () =>
    JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    ).state;

  test('AC-2: lint deposits through evidence-gate with close lint argv and command hash', async () => {
    const h = harness();
    await h.run();
    const lint = callFor(h, 'lint');
    const closeLint = buildDefaultGates({
      config: configFor(),
      baseBranch: 'main',
      cwd: '/work',
      packageScripts: CAPTURE_SCRIPTS,
    }).find((g) => g.name === 'lint');
    assert.deepEqual(lint.args.slice(1), [
      '--standalone',
      '--scope-id',
      String(STORY),
      '--gate',
      'lint',
      '--worktree',
      '/work',
      '--cwd',
      tempRoot,
      '--',
      closeLint.cmd,
      ...closeLint.args,
    ]);
    assert.deepEqual(readState().preflightCredits.lint, {
      head: HEAD,
      configHash: lintHash,
    });
  });

  test('AC-3: typecheck deposits first, with close typecheck argv and command hash', async () => {
    const h = harness();
    await h.run();
    assert.equal(spawned(h.runCommand)[1], 'typecheck');
    const closeTypecheck = buildDefaultGates({
      config: configFor(),
      baseBranch: 'main',
      cwd: '/work',
      packageScripts: CAPTURE_SCRIPTS,
    }).find((g) => g.name === 'typecheck');
    assert.deepEqual(callFor(h, 'typecheck').args.slice(-4), [
      '--',
      closeTypecheck.cmd,
      ...closeTypecheck.args,
    ]);
    assert.deepEqual(readState().preflightCredits.typecheck, {
      head: HEAD,
      configHash: typecheckHash,
    });
  });

  test('AC-4: a failing typecheck is fix-required naming typecheck, before the suite', async () => {
    const h = harness({ outputs: { typecheck: { status: 2 } } });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'preflight');
    assert.match(stopStep(envelope).detail, /^typecheck finding/);
    assert.ok(!spawned(h.runCommand).includes('coverage-capture.js'));
    assert.ok(!('typecheck' in readState().preflightCredits));
  });

  test('AC-6: typecheck: null neither spawns nor deposits typecheck', async () => {
    const h = harness({
      config: configFor({
        project: {
          baseBranch: 'main',
          paths: { tempRoot },
          commands: { typecheck: null },
        },
      }),
    });
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.ok(!spawned(h.runCommand).includes('typecheck'));
    assert.deepEqual(Object.keys(readState().preflightCredits), ['lint']);
  });

  test('AC-2: format deposits the argv close executes after its own scoping', async () => {
    const config = configFor({
      project: {
        baseBranch: 'main',
        paths: { tempRoot },
        commands: { formatCheck: 'npx prettier --check .' },
      },
    });
    const h = harness({ config });
    h.deps.scopeGate = applyChangedFileScope;
    await h.run();
    const format = callFor(h, 'format');
    assert.deepEqual(format.args.slice(-5), [
      '--',
      'npx',
      'prettier',
      '--check',
      '.',
    ]);
  });

  test('AC-2: a disabled or scoped-out format deposits nothing', async () => {
    const disabled = harness({
      config: configFor({
        project: {
          baseBranch: 'main',
          paths: { tempRoot },
          commands: { formatCheck: null },
        },
      }),
    });
    disabled.deps.scopeGate = applyChangedFileScope;
    await disabled.run();
    assert.ok(!spawned(disabled.runCommand).includes('format'));
    const scopedOut = harness();
    await scopedOut.run();
    assert.ok(!spawned(scopedOut.runCommand).includes('format'));
  });

  test('AC-2: biome processing zero scoped files is clean, as close treats it', async () => {
    const h = harness({
      outputs: {
        format: {
          status: 1,
          stdout: 'No files were processed in the specified paths',
        },
      },
    });
    h.deps.scopeGate = ({ gate }) => ({
      gate,
      cmd: gate.cmd,
      args: [...gate.args.slice(0, -1), 'a.css'],
      skip: Boolean(gate.skip),
      tolerateNoFilesProcessed: gate.name === 'format',
    });
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.equal(callFor(h, 'format').args.at(-1), 'a.css');
  });

  test('AC-2: a format scope that cannot resolve is fix-required before any spawn', async () => {
    const h = harness();
    h.deps.scopeGate = () => {
      throw new Error('bad ref');
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'preflight');
    assert.match(
      stopStep(envelope).detail,
      /typecheck\/lint\/format gates: bad ref/,
    );
    assert.deepEqual(spawned(h.runCommand), [
      'update-maintainability-baseline.js',
    ]);
  });

  test('AC-5: a baselines-only seat commit carries the lint and typecheck credits to the seated head', async () => {
    const h = harness({
      outputs: {
        'update-crap-baseline.js': { status: 0, stdout: 'seated: 2' },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.headSha, SEATED_HEAD);
    const carried = buildDefaultGates({
      config: configFor(),
      baseBranch: 'main',
      cwd: '/work',
      packageScripts: CAPTURE_SCRIPTS,
    }).filter((g) => ['typecheck', 'lint'].includes(g.name));
    const close = await runCloseValidation({
      cwd: tempRoot,
      worktreePath: '/work',
      gates: carried,
      storyId: STORY,
      standalone: true,
      getHeadSha: () => SEATED_HEAD,
      getTreeFingerprint: () => null,
      runner: () => assert.fail('close must not re-run a carried gate'),
      runProjections: async () => {},
    });
    assert.deepEqual(
      close.skipped.map((x) => [x.gate.name, x.reason]),
      [
        ['typecheck', 'evidence-match'],
        ['lint', 'evidence-match'],
      ],
    );
    assert.equal(evidenceSkip('format', SEATED_HEAD, lintHash).skip, false);
  });

  test('AC-5: a seat commit touching anything outside baselines/ carries nothing', async () => {
    const h = harness({
      outputs: {
        'update-crap-baseline.js': { status: 0, stdout: 'seated: 2' },
      },
    });
    const run = h.deps.runCommand;
    h.deps.runCommand = async (cmd, args, opts) => {
      const res = await run(cmd, args, opts);
      if (h.world.dirty.length > 0) h.world.dirty.push('src/a.js');
      return res;
    };
    await h.run();
    assert.equal(evidenceSkip('lint', SEATED_HEAD, lintHash).skip, false);
    assert.equal(
      evidenceSkip('typecheck', SEATED_HEAD, typecheckHash).skip,
      false,
    );
  });

  test('AC-4: a CRAP regression in the fresh capture is fix-required and pushes nothing', async () => {
    const h = harness({
      outputs: { 'quality-preview.js --only crap': { status: 1 } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'post-capture');
    assert.match(stopStep(envelope).detail, /quality-preview-crap/);
    assert.ok(envelope.evidencePath);
    assert.ok(!spawned(h.runCommand).includes('git'), 'nothing was pushed');
    assert.equal(h.blocks.length, 0);
    const preview = callFor(h, 'quality-preview.js --only crap');
    assert.deepEqual(preview.args, [
      '.agents/scripts/quality-preview.js',
      '--only',
      'crap',
      '--changed-since',
      'origin/main',
    ]);
  });

  const baselinesConfig = () =>
    configFor({
      delivery: {
        quality: {
          gates: {
            maintainability: { enabled: true },
            crap: { enabled: true },
          },
        },
      },
    });

  for (const [gate, kind] of [
    ['check-baselines-independent', 'maintainability'],
    ['check-baselines-coverage', 'crap'],
  ]) {
    test(`AC-5: a ${kind} baselines breach names ${gate} and pushes nothing`, async () => {
      const h = harness({
        config: baselinesConfig(),
        outputs: { [`check-baselines.js ${kind}`]: { status: 1 } },
      });
      h.deps.presentBaselines = ['maintainability', 'crap'];
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 2);
      assert.equal(envelope.failedStep, 'post-capture');
      const detail = stopStep(envelope).detail;
      assert.match(detail, new RegExp(`${gate} \\(kinds: ${kind}\\)`));
      assert.ok(!spawned(h.runCommand).includes('git'));
    });
  }

  test('a baselines post-capture finding quotes its FAIL, remedy and row lines (#5968 AC-3)', async () => {
    const stdout = [
      '[check-baselines] 1 gate(s) — breaches=0, regressions=1',
      '  - crap: FAIL (breaches=0, regressions=1)',
      '    ↳ remedy: fix the named rows',
      '    · src/a.js::f: crap 3 → 9',
    ].join('\n');
    const h = harness({
      config: baselinesConfig(),
      outputs: { 'check-baselines.js crap': { status: 1, stdout } },
    });
    h.deps.presentBaselines = ['maintainability', 'crap'];
    const { envelope } = await h.run();
    assert.equal(
      stopStep(envelope).detail,
      'check-baselines-coverage (kinds: crap) finding (exit 1): - crap: FAIL (breaches=0, regressions=1); ↳ remedy: fix the named rows; · src/a.js::f: crap 3 → 9 — fix and commit, then re-run',
    );
  });

  test('a post-capture CRAP finding quotes its per-file rows, and is unchanged with none (#5968 AC-3)', async () => {
    const rows = harness({
      outputs: {
        'quality-preview.js --only crap': {
          status: 1,
          stdout: '| file | a | b | c |\n| src/a.js | -0.00 | +4.00 | 1 |',
        },
      },
    });
    const quoted = stopStep((await rows.run()).envelope).detail;
    assert.match(
      quoted,
      /\(exit 1\): \| src\/a\.js \| -0\.00 \| \+4\.00 \| 1 \| — fix/,
    );
    const bare = harness({
      outputs: { 'quality-preview.js --only crap': { status: 1 } },
    });
    assert.equal(
      stopStep((await bare.run()).envelope).detail,
      'quality-preview-crap finding (exit 1) — fix and commit, then re-run',
    );
  });

  test('AC-6: post-capture runs once after depositor and seat, lock-free, and skips at an unchanged head', async () => {
    const h = harness({ config: baselinesConfig() });
    h.deps.presentBaselines = ['maintainability', 'crap'];
    const { envelope } = await h.run();
    const post = envelope.steps.find((s) => s.name === 'post-capture');
    assert.equal(post.outcome, 'ran');
    const keys = spawned(h.runCommand);
    assert.deepEqual(keys.slice(keys.indexOf('update-crap-baseline.js') + 1), [
      'quality-preview.js --only crap',
      'check-baselines.js maintainability',
      'check-baselines.js crap',
      'git',
    ]);
    const baselines = callFor(h, 'check-baselines.js crap');
    assert.equal(baselines.opts.env.BASELINE_REF, 'origin/main');
    for (const call of h.runCommand.calls.slice(-4, -1)) {
      assert.ok(
        !Object.keys(call.opts.env).some((k) => /LOCK_EVENT/.test(k)),
        'no lock-event channel reaches a post-capture child',
      );
    }
    h.runCommand.calls.length = 0;
    const again = await h.run();
    const rerun = again.envelope.steps.find((s) => s.name === 'post-capture');
    assert.equal(rerun.outcome, 'skipped');
    assert.ok(
      !spawned(h.runCommand).includes('quality-preview.js --only crap'),
    );
  });

  test('AC-7: without a coverage capture no post-capture CRAP runs, but baselines still do', async () => {
    const h = harness({ scripts: { test: 'x' }, config: baselinesConfig() });
    h.deps.presentBaselines = ['maintainability', 'crap'];
    const { envelope } = await h.run();
    assert.equal(envelope.depositor, 'test');
    const keys = spawned(h.runCommand);
    assert.ok(!keys.includes('quality-preview.js --only crap'));
    assert.ok(keys.includes('check-baselines.js maintainability'));
    assert.ok(keys.includes('check-baselines.js crap'));
  });
});

describe('story-handoff — an over-budget capture (exit 76, Story #5949)', () => {
  const overBudgetConfig = (onOverBudget) =>
    configFor({
      delivery: {
        quality: {
          gates: {
            maintainability: { enabled: true },
            crap: { enabled: true },
            ...(onOverBudget ? { coverage: { onOverBudget } } : {}),
          },
        },
      },
    });
  const overBudget = { 'coverage-capture.js': { status: 76, stdout: '' } };

  test('defer-to-ci settles ready, deposits no credit and skips only the coverage-reading gates', async () => {
    const h = harness({
      config: overBudgetConfig('defer-to-ci'),
      outputs: overBudget,
    });
    h.deps.presentBaselines = ['maintainability', 'crap'];
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(envelope.coverage, {
      status: 'deferred',
      reason: 'over-budget',
      policy: 'defer-to-ci',
    });
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(credited.outcome, 'deferred');
    assert.match(credited.detail, /deferred to CI/);
    const keys = spawned(h.runCommand);
    assert.ok(keys.includes('check-baselines.js maintainability'));
    assert.ok(keys.includes('update-maintainability-baseline.js'));
    for (const reader of [
      'quality-preview.js --only crap',
      'check-baselines.js crap',
      'update-crap-baseline.js',
    ]) {
      assert.ok(!keys.includes(reader), `${reader} must not run`);
    }
    const state = JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    ).state;
    assert.equal(state.creditHead, undefined);
    assert.equal(state.coverageDeferredHead, HEAD);
  });

  test('the default block policy blocks naming onOverBudget', async () => {
    const h = harness({ config: overBudgetConfig(null), outputs: overBudget });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 1);
    assert.equal(envelope.status, 'blocked');
    assert.equal(envelope.failedStep, 'credited-run');
    assert.match(envelope.reason, /onOverBudget/);
    assert.equal(envelope.coverage, undefined);
    assert.equal(h.blocks.length, 1);
  });

  test('a later real capture at the same HEAD re-opens the CRAP seat the deferral skipped', async () => {
    const outputs = { ...overBudget };
    const h = harness({ config: overBudgetConfig('defer-to-ci'), outputs });
    await h.run();
    delete outputs['coverage-capture.js'];
    h.runCommand.calls.length = 0;
    const { envelope } = await h.run();
    assert.equal(envelope.coverage, undefined);
    assert.ok(spawned(h.runCommand).includes('update-crap-baseline.js'));
  });

  test('a timeout still hands back fix-required under defer-to-ci', async () => {
    const h = harness({
      config: overBudgetConfig('defer-to-ci'),
      outputs: { 'coverage-capture.js': { status: 124 } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.match(stopStep(envelope).detail, /timed out/);
  });
});

describe('story-handoff — CI is the suite of record (Story #5955)', () => {
  const postureConfig = (coverage) =>
    configFor({
      delivery: {
        quality: {
          gates: {
            maintainability: { enabled: true },
            crap: { enabled: true },
            coverage,
          },
        },
      },
    });
  const withChannelSpy = (h) => {
    let opened = 0;
    h.deps.createLockChannel = () => {
      opened += 1;
      throw new Error('no lock channel may open under suiteOfRecord: ci');
    };
    return () => opened;
  };

  test('settles ready without a lock or a capture, skipping the coverage readers', async () => {
    const h = harness({
      config: postureConfig({
        suiteOfRecord: 'ci',
        ciRatchetCheck: 'coverage-ratchet',
      }),
    });
    h.deps.presentBaselines = ['maintainability', 'crap'];
    const channels = withChannelSpy(h);
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.status, 'ready');
    assert.deepEqual(envelope.coverage, {
      status: 'deferred',
      reason: 'suite-of-record-ci',
      policy: 'suite-of-record',
    });
    const credited = envelope.steps.find((s) => s.name === 'credited-run');
    assert.equal(credited.outcome, 'deferred');
    assert.equal(channels(), 0, 'no full-suite lock channel opened');
    const keys = spawned(h.runCommand);
    assert.ok(!keys.includes('coverage-capture.js'));
    assert.ok(keys.includes('check-baselines.js maintainability'));
    for (const reader of [
      'quality-preview.js --only crap',
      'check-baselines.js crap',
      'update-crap-baseline.js',
    ]) {
      assert.ok(!keys.includes(reader), `${reader} must not run`);
    }
  });

  test('blocks naming both keys when no ratchet check is declared', async () => {
    const h = harness({ config: postureConfig({ suiteOfRecord: 'ci' }) });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 1);
    assert.equal(envelope.status, 'blocked');
    assert.equal(envelope.failedStep, 'credited-run');
    assert.equal(envelope.reason, 'ci-ratchet-undeclared');
    assert.match(h.blocks[0].detail, /coverage\.suiteOfRecord/);
    assert.match(h.blocks[0].detail, /coverage\.ciRatchetCheck/);
    assert.ok(!spawned(h.runCommand).includes('coverage-capture.js'));
  });

  test('the local posture and the test depositor change nothing', async () => {
    const local = harness({
      config: postureConfig({ suiteOfRecord: 'local' }),
    });
    const { envelope } = await local.run();
    assert.equal(envelope.coverage, undefined);
    assert.ok(spawned(local.runCommand).includes('coverage-capture.js'));
    const testDepositor = harness({
      config: postureConfig({ suiteOfRecord: 'ci' }),
      scripts: {},
    });
    const result = await testDepositor.run();
    assert.equal(result.envelope.depositor, 'test');
    assert.equal(result.envelope.status, 'ready');
    assert.equal(result.envelope.coverage, undefined);
  });
});

describe('story-handoff — a suite that lost workers to host memory (exit 77, Story #5959)', () => {
  const counts = {
    testsPassed: 812,
    testsFailed: 0,
    workersLost: 2,
    filesAffected: ['a.test.js'],
    peakWorkerRssMb: 1900,
  };
  const countsLine = JSON.stringify({ hostResources: counts });
  const readState = () =>
    JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    ).state;

  for (const [depositor, scripts, key] of [
    ['coverage-capture', CAPTURE_SCRIPTS, 'coverage-capture.js'],
    ['test', { test: 'x' }, 'evidence-gate.js'],
  ]) {
    test(`AC-2: a ${depositor} exit 77 settles blocked host-resources with no credit`, async () => {
      const h = harness({ scripts, outputs: { [key]: { status: 77 } } });
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 1);
      assert.equal(envelope.status, 'blocked');
      assert.equal(envelope.depositor, depositor);
      assert.equal(envelope.failedStep, 'credited-run');
      assert.equal(envelope.reason, 'host-resources');
      assert.equal(envelope.hostResources, undefined);
      const { detail } = stopStep(envelope);
      assert.match(detail, /no test failed/);
      assert.match(detail, /fewer workers/);
      assert.match(detail, /larger host/);
      assert.match(detail, /exit 76/);
      assert.match(detail, /defer-to-ci/);
      assert.doesNotMatch(detail, /fix the failing tests/);
      assert.equal(readState().creditHead, undefined);
      assert.equal(h.blocks.length, 1);
      assert.equal(h.blocks[0].reason, 'host-resources');
      assert.equal(h.frictions.length, 1);
      assert.equal(h.frictions[0].category, 'host-resources');
      assert.equal(h.frictions[0].tool, 'story-handoff');
      assert.equal(h.frictions[0].details.exitCode, 77);
      assert.equal(h.frictions[0].details.depositor, depositor);
      assert.equal(h.frictions[0].details.hostResources, undefined);
    });
  }

  test('AC-3/AC-4: the last counts line reaches the envelope, the detail and the friction record', async () => {
    const stdout = [
      JSON.stringify({ hostResources: { workersLost: 9 } }),
      countsLine,
      'trailing noise',
    ].join('\n');
    const h = harness({
      outputs: { 'coverage-capture.js': { status: 77, stdout } },
    });
    const { envelope } = await h.run();
    assert.deepEqual(envelope.hostResources, counts);
    const { detail } = stopStep(envelope);
    assert.match(
      detail,
      /testsPassed: 812, testsFailed: 0, workersLost: 2, peakWorkerRssMb: 1900/,
    );
    assert.doesNotMatch(detail, /a\.test\.js/);
    assert.match(h.blocks[0].detail, /workersLost: 2/);
    assert.deepEqual(h.frictions[0].details.hostResources, counts);
  });

  for (const [why, stdout] of [
    ['malformed', '{"hostResources": {oops'],
    ['non-object', '{"hostResources": [1, 2]}'],
    ['array', '[{"hostResources": {}}]'],
  ]) {
    test(`AC-3: a ${why} counts line is ignored and the run still blocks`, async () => {
      const h = harness({
        outputs: { 'coverage-capture.js': { status: 77, stdout } },
      });
      const { envelope } = await h.run();
      assert.equal(envelope.reason, 'host-resources');
      assert.equal('hostResources' in envelope, false);
    });
  }

  test('AC-4: a failing friction append never changes the envelope', async () => {
    const h = harness({ outputs: { 'coverage-capture.js': { status: 77 } } });
    h.deps.emitFriction = async () => {
      throw new Error('disk full');
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 1);
    assert.equal(envelope.reason, 'host-resources');
  });

  test('AC-5: a second 124 at the same HEAD points past a plain re-run; the first reads as before', async () => {
    const h = harness({ outputs: { 'coverage-capture.js': { status: 124 } } });
    const first = await h.run();
    assert.equal(first.exitCode, 2);
    assert.match(
      stopStep(first.envelope).detail,
      /^suite timed out \(exit 124\) — usually host contention; re-run the handoff/,
    );
    const second = await h.run();
    assert.equal(second.exitCode, 2);
    const { detail } = stopStep(second.envelope);
    assert.match(detail, /timed out again at this HEAD/);
    assert.match(detail, /coverage\.timeoutMs/);
    assert.match(detail, /exit 76/);
    assert.match(detail, /quieter host/);
    assert.equal(h.frictions.length, 0);
  });
});

// Story #5954 — under delivery.close.baseSync "on-conflict" a handoff re-run
// probes before merging; the first invocation always merges.
describe('story-handoff — on-conflict base-merge re-runs (Story #5954)', () => {
  const MERGE_BASE = 'f'.repeat(40);
  const onConflict = () =>
    configFor({ delivery: { close: { baseSync: 'on-conflict' } } });

  function probing(h, probe) {
    const probes = [];
    let syncs = 0;
    const { syncFromBase } = h.deps;
    h.deps.probeBaseSync = async (args) => {
      probes.push(args);
      return probe;
    };
    h.deps.syncFromBase = async (...args) => {
      syncs += 1;
      return syncFromBase(...args);
    };
    return { probes, syncs: () => syncs };
  }

  const baselinesEnv = (h) =>
    h.runCommand.calls.find((c) => c.key === 'check-baselines.js')?.opts.env
      ?.BASELINE_REF;

  test('AC-12: the first invocation always merges and records the settled step', async () => {
    const h = harness({ config: onConflict() });
    const p = probing(h, { skip: true, incoming: 2, mergeBase: MERGE_BASE });
    const { envelope } = await h.run();
    assert.equal(p.probes.length, 0, 'no record yet: no probe');
    assert.equal(p.syncs(), 1);
    assert.equal('baseMerge' in envelope, false);
    const { state } = JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    );
    assert.equal(state.baseMergeSettled, true);
  });

  test('AC-12: a conflict-free, disjoint re-run skips the merge and says so', async () => {
    const h = harness({ config: onConflict() });
    await h.run();
    const p = probing(h, { skip: true, incoming: 2, mergeBase: MERGE_BASE });
    // A new Story commit since: every credit is re-earned on the new head.
    h.world.head = 'e'.repeat(40);
    h.runCommand.calls.length = 0;
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(p.probes.length, 1);
    assert.equal(p.syncs(), 0, 'no merge ran');
    const merge = envelope.steps.find((s) => s.name === 'base-merge');
    assert.equal(merge.outcome, 'skipped');
    assert.match(merge.detail, /conflict-free and disjoint: 2 incoming path/);
    assert.deepEqual(envelope.baseMerge, {
      skipped: 'conflict-free',
      incoming: 2,
    });
    assert.equal(
      baselinesEnv(h),
      MERGE_BASE,
      'check-baselines compares to the merge-base',
    );
  });

  test('a re-run whose probe does not skip merges as before', async () => {
    const h = harness({ config: onConflict() });
    await h.run();
    const p = probing(h, { skip: false, reason: 'intersects', path: 'a.js' });
    const { envelope } = await h.run();
    assert.equal(p.syncs(), 1);
    assert.equal('baseMerge' in envelope, false);
  });

  test('AC-8: unset, a re-run never probes', async () => {
    const h = harness();
    await h.run();
    const p = probing(h, { skip: true, incoming: 2, mergeBase: MERGE_BASE });
    await h.run();
    assert.equal(p.probes.length, 0);
    assert.equal(p.syncs(), 1);
  });
});

describe('story-handoff — the duplication re-score (Story #5956)', () => {
  const RESCORED_HEAD = 'c'.repeat(40);
  const dupConfig = () =>
    configFor({
      delivery: {
        quality: { gates: { duplication: { enabled: true } } },
      },
    });
  const dupRows = (rows) =>
    JSON.stringify({
      kind: 'duplication',
      rows: Object.entries(rows).map(([p, v]) => ({ path: p, percentage: v })),
    });

  /** A re-score double that commits: HEAD moves as the real commit would. */
  const committing = (h) => () => {
    h.world.head = RESCORED_HEAD;
    return {
      ran: true,
      committed: true,
      sha: 'c'.repeat(7),
      movedPaths: ['lib/a.js'],
      moved: [{ path: 'lib/a.js', before: 1, after: 9 }],
      partners: { 'lib/a.js': ['lib/b.js'] },
    };
  };

  test('AC-1: a raised duplication row is fix-required at post-capture, names base → head and the clone partner, and pushes nothing', async () => {
    const cwd = path.join(tempRoot, 'wt');
    mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
    writeFileSync(
      path.join(cwd, 'baselines', 'duplication.json'),
      dupRows({ 'lib/a.js': 9, 'lib/c.js': 2, 'lib/new.js': 4 }),
    );
    const h = harness({
      cwd,
      config: dupConfig(),
      outputs: { 'check-baselines.js duplication': { status: 1 } },
    });
    h.deps.runDuplicationRescore = committing(h);
    h.deps.presentBaselines = ['duplication'];
    const git = h.world.git;
    const shows = [];
    h.deps.git = (c, ...args) => {
      if (args[0] !== 'show') return git(c, ...args);
      shows.push(args[1]);
      return { status: 0, stdout: dupRows({ 'lib/a.js': 1, 'lib/c.js': 2 }) };
    };
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'post-capture');
    const detail = stopStep(envelope).detail;
    assert.match(detail, /check-baselines-independent \(kinds: duplication\)/);
    assert.match(detail, /lib\/a\.js 1% → 9% \(clones: lib\/b\.js\)/);
    assert.match(detail, /lib\/new\.js none → 4%/);
    assert.doesNotMatch(detail, /lib\/c\.js/);
    assert.deepEqual(shows, ['origin/main:baselines/duplication.json']);
    assert.ok(!spawned(h.runCommand).includes('git'), 'nothing was pushed');
  });

  test('an unreadable base baseline appends nothing and keeps the finding', async () => {
    const h = harness({
      config: dupConfig(),
      outputs: { 'check-baselines.js duplication': { status: 1 } },
    });
    h.deps.presentBaselines = ['duplication'];
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.doesNotMatch(stopStep(envelope).detail, /raised duplication/);
  });

  test('AC-3: runs after the base merge and before preflight with close inputs, moves HEAD on a commit, and skips at the same HEAD', async () => {
    const h = harness();
    const inputs = [];
    const commit = committing(h);
    h.deps.runDuplicationRescore = async (input) => {
      inputs.push(input);
      return commit();
    };
    const { envelope } = await h.run();
    assert.deepEqual(stepNames(envelope).slice(0, 4), [
      'base-merge',
      'duplication-rescore',
      'seat-static',
      'preflight',
    ]);
    const step = envelope.steps[1];
    assert.equal(step.outcome, 'ran');
    assert.match(step.detail, /lib\/a\.js 1% → 9%; committed untagged c{7}/);
    assert.equal(envelope.headSha, RESCORED_HEAD);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].storyBranch, `story-${STORY}`);
    assert.equal(inputs[0].worktreePath, '/work');
    assert.equal(inputs[0].baseBranch, 'main');

    const again = await h.run();
    assert.equal(inputs.length, 1, 'no second scan at the same HEAD');
    assert.equal(again.envelope.steps[1].outcome, 'skipped');
  });

  test('an unchanged scan settles ran', async () => {
    const h = harness({
      rescore: {
        ran: false,
        committed: false,
        reason: 'unchanged',
        moved: [],
        partners: {},
      },
    });
    const { envelope } = await h.run();
    assert.deepEqual(
      { outcome: envelope.steps[1].outcome, detail: envelope.steps[1].detail },
      { outcome: 'ran', detail: 'unchanged' },
    );
  });

  for (const reason of ['gate-disabled', 'no-changed-files']) {
    test(`AC-4: ${reason} settles skipped`, async () => {
      const h = harness({ rescore: { ran: false, committed: false, reason } });
      const { envelope } = await h.run();
      assert.equal(envelope.steps[1].outcome, 'skipped');
      assert.equal(envelope.steps[1].detail, reason);
    });
  }

  for (const reason of [
    'scorer-failed: jscpd exploded',
    'git-failed: hook refused',
    'wrong-branch',
    'dirty-tree',
    'config-failed: bad json',
  ]) {
    test(`AC-4: ${reason} settles error, the run continues, and a re-run retries`, async () => {
      const h = harness({ rescore: { ran: false, committed: false, reason } });
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, 0);
      assert.equal(envelope.steps[1].outcome, 'error');
      assert.equal(envelope.steps[1].detail, reason);
      assert.equal(envelope.steps.at(-1).name, 'review');
      await h.run();
      assert.equal(h.rescores.length, 2, 'an error records nothing');
    });
  }

  test('AC-4: a throwing re-score settles error and the run continues', async () => {
    const h = harness({
      rescore: () => {
        throw new Error('boom');
      },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 0);
    assert.equal(envelope.steps[1].outcome, 'error');
    assert.match(envelope.steps[1].detail, /boom/);
  });
});

describe('story-handoff — seat order, step env and post-seat checks (Story #5960)', () => {
  const lintHash = hashCommandConfig({
    cmd: 'npm',
    args: ['run', 'lint'],
    cwd: '/work',
  });
  const lintSkip = (sha) =>
    shouldSkip(
      {
        storyId: STORY,
        gateName: 'lint',
        currentSha: sha,
        configHash: lintHash,
      },
      { cwd: tempRoot, standalone: true },
    );
  const readState = () =>
    JSON.parse(
      readFileSync(
        path.join(tempRoot, 'orchestration', `story-handoff-${STORY}.json`),
        'utf8',
      ),
    ).state;
  const gatesConfig = (gates, handoff) =>
    configFor({
      delivery: {
        quality: { gates },
        ...(handoff ? { handoff } : {}),
      },
    });
  const coverageConfig = (coverage = {}) =>
    gatesConfig({ crap: { enabled: true }, coverage });
  const checksConfig = (overBudget) =>
    gatesConfig(
      { coverage: overBudget ? { onOverBudget: 'defer-to-ci' } : {} },
      { postSeatChecks: [{ cmd: 'consumer-check', args: ['--rows'] }] },
    );

  test('AC-5: on the capture path missing coverage rows seat beside CRAP after the capture and the credit moves to the seat commit', async () => {
    const h = harness({
      config: coverageConfig(),
      outputs: {
        'update-coverage-baseline.js': { status: 0, stdout: 'seated: 2' },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    const keys = spawned(h.runCommand);
    assert.deepEqual(
      keys.slice(keys.indexOf('coverage-capture.js') + 1).slice(0, 2),
      ['update-crap-baseline.js', 'update-coverage-baseline.js'],
    );
    const seat = h.runCommand.calls.find(
      (c) => c.key === 'update-coverage-baseline.js',
    );
    assert.deepEqual(seat.args.slice(1), ['--seat-missing']);
    assert.equal(envelope.headSha, SEATED_HEAD);
    assert.equal(readState().creditHead, SEATED_HEAD);
  });

  test('AC-5: no coverage seat on the test path, with the gate disabled, or under a coverage deferral', async () => {
    const runs = [
      harness({ config: coverageConfig(), scripts: { test: 'x' } }),
      harness({ config: coverageConfig({ enabled: false }) }),
      harness({
        config: coverageConfig({ onOverBudget: 'defer-to-ci' }),
        outputs: { 'coverage-capture.js': { status: 76, stdout: '' } },
      }),
    ];
    for (const h of runs) {
      const { envelope } = await h.run();
      assert.equal(envelope.status, 'ready');
      assert.ok(!spawned(h.runCommand).includes('update-coverage-baseline.js'));
    }
  });

  test('AC-6: the MI seat runs after the base merge and before preflight, commits, and skips at the same HEAD', async () => {
    const h = harness({
      outputs: {
        'update-maintainability-baseline.js': {
          status: 0,
          stdout: '[Maintainability] seated: 1',
        },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    const staticSeat = envelope.steps.find((s) => s.name === 'seat-static');
    assert.equal(staticSeat.outcome, 'ran');
    assert.deepEqual(spawned(h.runCommand).slice(0, 2), [
      'update-maintainability-baseline.js',
      'typecheck',
    ]);
    assert.equal(readState().staticSeatHead, SEATED_HEAD);
    assert.equal(readState().preflightHead, SEATED_HEAD);
    h.runCommand.calls.length = 0;
    const again = await h.run();
    const rerun = again.envelope.steps.find((s) => s.name === 'seat-static');
    assert.equal(rerun.outcome, 'skipped');
    assert.ok(
      !spawned(h.runCommand).includes('update-maintainability-baseline.js'),
    );
  });

  test('AC-6: a disabled maintainability gate spawns no MI seat', async () => {
    const h = harness({
      config: gatesConfig({ maintainability: { enabled: false } }),
    });
    await h.run();
    assert.ok(
      !spawned(h.runCommand).includes('update-maintainability-baseline.js'),
    );
  });

  test('AC-7: every child gets MANDREL_HANDOFF_STEP for its step, over an inherited value', async () => {
    const h = harness({ config: checksConfig() });
    h.deps.env = { MANDREL_HANDOFF_STEP: 'stale', KEEP: '1' };
    await h.run();
    const stepOf = (key) =>
      h.runCommand.calls.find((c) => c.key === key).opts.env;
    assert.equal(
      stepOf('update-maintainability-baseline.js').MANDREL_HANDOFF_STEP,
      'seat-static',
    );
    assert.equal(stepOf('npm').MANDREL_HANDOFF_STEP, 'preflight');
    assert.equal(
      stepOf('coverage-capture.js').MANDREL_HANDOFF_STEP,
      'credited-run',
    );
    assert.equal(
      stepOf('update-crap-baseline.js').MANDREL_HANDOFF_STEP,
      'seat',
    );
    assert.equal(stepOf('consumer-check').MANDREL_HANDOFF_STEP, 'post-capture');
    assert.equal(stepOf('git').MANDREL_HANDOFF_STEP, 'push');
    assert.equal(stepOf('git').KEEP, '1');
  });

  test('AC-8: a failing post-seat check is fix-required at post-capture, naming it, and nothing is pushed', async () => {
    const h = harness({
      config: checksConfig(),
      outputs: { 'consumer-check': { status: 1, stdout: 'missing row' } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'post-capture');
    assert.match(stopStep(envelope).detail, /consumer-check --rows/);
    assert.match(envelope.evidencePath, /post-seat-1/);
    const check = h.runCommand.calls.find((c) => c.key === 'consumer-check');
    assert.deepEqual(check.args, ['--rows']);
    assert.ok(!spawned(h.runCommand).includes('git'), 'nothing was pushed');
    assert.equal(lintSkip(HEAD).skip, false, 'no lint credit');
  });

  test('AC-9: with post-seat checks declared, lint runs bare and is credited only once they pass at HEAD', async () => {
    const h = harness({ config: checksConfig() });
    const run = h.deps.runCommand;
    let creditedBeforeChecks = null;
    h.deps.runCommand = async (cmd, args, opts) => {
      if (cmd === 'consumer-check') creditedBeforeChecks = lintSkip(HEAD).skip;
      return run(cmd, args, opts);
    };
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.ok(!spawned(h.runCommand).includes('lint'), 'no evidence-gate lint');
    const lint = h.runCommand.calls.find((c) => c.key === 'npm');
    assert.deepEqual(lint.args, ['run', 'lint']);
    assert.equal(creditedBeforeChecks, false);
    assert.equal(lintSkip(HEAD).skip, true);
    assert.equal(readState().preflightCredits.lint.pending, undefined);
  });

  test('AC-9: a held lint credit re-keys across a baselines-only seat commit and is recorded at the seated HEAD', async () => {
    const h = harness({
      config: checksConfig(),
      outputs: {
        'update-crap-baseline.js': { status: 0, stdout: 'seated: 1' },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.headSha, SEATED_HEAD);
    assert.equal(lintSkip(SEATED_HEAD).skip, true);
    assert.equal(lintSkip(HEAD).skip, false);
  });

  test('AC-9: under a coverage deferral the post-seat checks are skipped and no lint credit is written', async () => {
    const h = harness({
      config: checksConfig(true),
      outputs: { 'coverage-capture.js': { status: 76, stdout: '' } },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.status, 'ready');
    assert.ok(!spawned(h.runCommand).includes('consumer-check'));
    const post = envelope.steps.find((s) => s.name === 'post-capture');
    assert.match(post.detail, /post-seat checks skipped/);
    assert.equal(lintSkip(HEAD).skip, false);
  });
});

/**
 * Story #5970 — every handoff run leaves one signal naming its stopping step,
 * cause and per-step time; the envelope carries the same cause and attempt.
 */
describe('story-handoff — per-run telemetry (Story #5970)', () => {
  const records = () => {
    const file = signalsFile(null, STORY, configFor());
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((r) => r.phase === 'handoff');
  };
  const failing = { outputs: { lint: { status: 1, stdout: 'lint finding' } } };
  const crapOn = () =>
    configFor({
      delivery: { quality: { gates: { crap: { enabled: true } } } },
    });

  test('AC-1: every step carries an integer durationMs; only a credit-reused skip carries skippedByCredit', async () => {
    const h = harness();
    const first = await h.run();
    for (const step of first.envelope.steps) {
      assert.ok(Number.isInteger(step.durationMs), step.name);
      assert.equal(step.skippedByCredit, undefined, step.name);
    }
    const seat = first.envelope.steps.find((s) => s.name === 'seat');
    assert.equal(seat.outcome, 'skipped', 'seated: 0 is a plain skip');
    const rerun = await h.run();
    const byName = Object.fromEntries(
      rerun.envelope.steps.map((s) => [s.name, s]),
    );
    for (const name of ['preflight', 'credited-run', 'seat', 'post-capture']) {
      assert.equal(byName[name].skippedByCredit, true, name);
    }
    assert.equal(byName.push.outcome, 'skipped');
    assert.equal(byName.push.skippedByCredit, undefined, 'origin at HEAD');
  });

  test('AC-1: a held review that already matches the diff is a credit skip, timed by reviewMs', async () => {
    const h = harness({ heldDeposit: { halted: false, severity: null } });
    const { envelope } = await h.run();
    const review = envelope.steps.find((s) => s.name === 'review');
    assert.equal(review.skippedByCredit, true);
    assert.equal(review.durationMs, envelope.reviewMs);
  });

  test('AC-2/AC-5: three fix-required runs append one retry each, attempts 1, 2 and 3', async () => {
    const h = harness(failing);
    const envelopes = [];
    for (let i = 0; i < 3; i += 1) envelopes.push((await h.run()).envelope);
    const written = records();
    assert.deepEqual(
      written.map((r) => r.details.attempt),
      [1, 2, 3],
    );
    assert.deepEqual(
      envelopes.map((e) => e.attempt),
      [1, 2, 3],
    );
    for (const [i, record] of written.entries()) {
      assert.equal(validateSignal(record).valid, true);
      assert.equal(record.kind, 'retry');
      assert.equal(record.emitter.tool, 'story-handoff');
      assert.equal(record.details.status, 'fix-required');
      assert.equal(record.details.failedStep, 'preflight');
      assert.equal(record.details.cause, 'lint');
      assert.equal(record.details.check, 'lint');
      assert.equal(envelopes[i].cause, 'lint');
      assert.ok(Number.isInteger(record.details.stepDurationsMs.preflight));
    }
  });

  test('AC-4: a ready run appends one trace record with suite timings and no retry', async () => {
    const { envelope } = await harness().run();
    const written = records();
    assert.equal(written.length, 1);
    const [record] = written;
    assert.equal(validateSignal(record).valid, true);
    assert.equal(record.kind, 'trace');
    assert.equal(record.details.status, 'ready');
    assert.equal(record.details.attempt, 1);
    assert.equal(envelope.attempt, 1);
    assert.equal(envelope.cause, undefined);
    assert.ok('suiteTimings' in record.details);
    assert.ok(Number.isInteger(record.details.stepDurationsMs['credited-run']));
    assert.equal(record.details.reviewMs, envelope.reviewMs);
  });

  test('AC-6: a throwing writer or reader leaves status and exit code unchanged', async () => {
    for (const opts of [{}, failing]) {
      const baseline = await harness(opts).run();
      const h = harness(opts);
      h.deps.writeSignal = async () => {
        throw new Error('disk gone');
      };
      h.deps.readSignals = async () => {
        throw new Error('disk gone');
      };
      const { envelope, exitCode } = await h.run();
      assert.equal(exitCode, baseline.exitCode);
      assert.equal(envelope.status, baseline.envelope.status);
      assert.equal(envelope.attempt, null);
    }
  });

  test('AC-7: no record carries a file path; the evidence path stays in the envelope', async () => {
    const { envelope } = await harness(failing).run();
    assert.ok(envelope.evidencePath);
    const [record] = records();
    const strings = JSON.stringify(record.details).match(/"[^"]*"/g) ?? [];
    assert.ok(
      strings.every((str) => !/[\\/]/.test(str)),
      `no path in ${JSON.stringify(record.details)}`,
    );
  });

  const HALTED = { halted: true, severity: { critical: 1 } };
  const gitFails = (stdout) => ({ outputs: { git: { status: 1, stdout } } });
  const causes = [
    ['an uncommitted tree', {}, 'precheck', (h) => (h.world.dirty = ['x.js'])],
    ['the wrong branch', { world: gitWorld({ branch: 'main' }) }, 'precheck'],
    [
      'an unresolved HEAD',
      {},
      'precheck',
      (h) => {
        const { git } = h.deps;
        h.deps.git = (cwd, ...args) =>
          args[0] === 'rev-parse' ? { status: 128 } : git(cwd, ...args);
      },
    ],
    [
      'a merge conflict',
      { sync: { synced: false, kind: 'conflict', conflictFiles: ['a.js'] } },
      'base-merge-conflict',
    ],
    [
      'a missing merge driver',
      { sync: { synced: false, kind: 'merge-driver-missing', stderr: 'x' } },
      'merge-driver-unregistered',
    ],
    [
      'an unfetchable base',
      { sync: { synced: false, kind: 'fetch-failed', stderr: 'x' } },
      'base-branch-unconfirmed',
    ],
    [
      'another merge failure',
      { sync: { synced: false, kind: 'weird', stderr: 'x' } },
      'base-merge-failed',
    ],
    ...[
      [75, 'lock-wait-expired'],
      [78, 'host-admission'],
      [124, 'suite-timeout'],
      [1, 'red-suite'],
      [76, 'capture-over-budget'],
      [77, 'other'],
    ].map(([status, cause]) => [
      `a credited run exiting ${status}`,
      { outputs: { 'coverage-capture.js': { status, stdout: '' } } },
      cause,
    ]),
    [
      'a credited run with no credit signal',
      { outputs: { 'coverage-capture.js': { status: 0, stdout: 'hm' } } },
      'no-credit-signal',
    ],
    [
      'a refused seat',
      {
        outputs: {
          'update-maintainability-baseline.js': { status: 1, stdout: '' },
        },
      },
      'seat-refused',
    ],
    [
      'a failed seat commit',
      {
        outputs: {
          'update-maintainability-baseline.js': {
            status: 0,
            stdout: 'seated: 1',
          },
        },
      },
      'seat-commit-failed',
      (h) => {
        const { git } = h.deps;
        h.deps.git = (cwd, ...args) =>
          args[0] === 'commit'
            ? { status: 1, stdout: '', stderr: 'nope' }
            : git(cwd, ...args);
      },
    ],
    [
      'a post-capture finding',
      () => ({
        config: crapOn(),
        outputs: {
          'quality-preview.js --only crap': { status: 1, stdout: '' },
        },
      }),
      'post-capture',
    ],
    [
      'an unreachable remote',
      { world: gitWorld({ lsRemoteFails: true }) },
      'remote-unreachable',
    ],
    [
      'a rejected push',
      gitFails(' ! [remote rejected] story-5518 -> story-5518 (declined)'),
      'push-rejected',
    ],
    [
      'a branch behind its remote',
      gitFails(
        ' ! [rejected]        story-5518 -> story-5518 (non-fast-forward)',
      ),
      'ref-behind',
    ],
    [
      'a failing pre-push hook',
      gitFails('husky - pre-push failed'),
      'push-hook',
    ],
    [
      'an unconfirmed push',
      { outputs: { git: { status: 0, keepRemote: true } } },
      'push-unconfirmed',
    ],
    ['a held review CRITICAL', { deposit: HALTED }, 'review-critical'],
  ];
  for (const [label, given, cause, arrange] of causes) {
    test(`AC-3: ${label} records cause ${cause}`, async () => {
      const opts = typeof given === 'function' ? given() : given;
      const h = harness(opts);
      arrange?.(h);
      const { envelope } = await h.run();
      assert.equal(envelope.cause, cause, stopStep(envelope)?.detail);
      const [record] = records();
      assert.equal(record.kind, 'retry');
      assert.equal(record.details.cause, cause);
      assert.equal(record.details.failedStep, envelope.failedStep);
    });
  }

  test('AC-3: a ratchet finding records ratchet with its check key', async () => {
    const cwd = path.join(tempRoot, 'wt');
    mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
    writeFileSync(path.join(cwd, 'baselines', 'arch-cycles.json'), '{}');
    const h = harness({
      cwd,
      outputs: {
        'check-arch-cycles.js': {
          status: 1,
          stdout: '+ a.js -> b.js\n[arch-cycles] added=1 (gate fail)',
        },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.cause, 'ratchet');
    const [record] = records();
    assert.equal(record.details.cause, 'ratchet');
    assert.equal(record.details.check, 'arch-cycles');
  });

  test('AC-3: a CRITICAL that aborts the credited run records review-critical', async () => {
    const h = harness({ deposit: HALTED });
    const { computeReview } = h.deps;
    let captureStarted;
    const started = new Promise((resolve) => {
      captureStarted = resolve;
    });
    h.deps.runCommand = (cmd, args, opts) => {
      if (path.basename(args[0] ?? '') !== 'coverage-capture.js') {
        return h.runCommand(cmd, args, opts);
      }
      captureStarted();
      return new Promise((resolve) =>
        opts.signal.addEventListener('abort', () =>
          resolve({ status: 143, stdout: '', stderr: '' }),
        ),
      );
    };
    h.deps.computeReview = async (input) => {
      await started;
      return computeReview(input);
    };
    const { envelope } = await h.run();
    assert.equal(envelope.failedStep, 'review');
    assert.equal(
      envelope.steps.find((s) => s.name === 'credited-run').outcome,
      'aborted',
    );
    assert.equal(envelope.cause, 'review-critical');
  });
});
