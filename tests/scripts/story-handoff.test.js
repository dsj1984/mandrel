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
import {
  buildDefaultGates,
  resolveCreditedDepositor,
} from '../../.agents/scripts/lib/close-validation/gates.js';
import {
  applyChangedFileScope,
  runCloseValidation,
} from '../../.agents/scripts/lib/close-validation/runner.js';
import { withFullSuiteLockAsync } from '../../.agents/scripts/lib/full-suite-lock.js';
import { runStoryHandoff } from '../../.agents/scripts/lib/orchestration/story-handoff.js';
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
    'update-maintainability-baseline.js': { status: 0, stdout: 'seated: 0' },
    git: { status: 0, stdout: '' },
  };
  const run = async (cmd, args, opts) => {
    const key = commandKey(cmd, args);
    calls.push({ key, cmd, args, opts });
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
    now: () => 0,
    evidenceCwd: tempRoot,
    scopeGate: scopeOutFormat,
    presentBaselines: [],
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
      'base-merge',
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
      'lint',
      'quality-preview.js',
      'coverage-capture.js',
      'update-crap-baseline.js',
      'update-maintainability-baseline.js',
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
    assert.match(envelope.steps.at(-1).detail, /hook rejected/);
    assert.equal(readFileSync(envelope.evidencePath, 'utf8'), 'hook rejected');
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
    assert.deepEqual(spawned(h.runCommand).slice(0, 6), [
      'lint',
      'quality-preview.js',
      ...Object.keys(RATCHET_BASELINES),
    ]);
    assert.match(envelope.steps[1].detail, /dead-exports-production/);
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
    assert.deepEqual(stepNames(envelope), ['base-merge']);
    assert.deepEqual(spawned(h.runCommand), [], 'no preflight check spawns');
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
    assert.deepEqual(blocked.envelope, baseline.envelope);
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
    assert.match(envelope.steps.at(-1).detail, /^red suite \(exit 1\)/);
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
    assert.match(envelope.steps.at(-1).detail, /^suite timed out \(exit 124\)/);
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
      'preflight',
      'credited-run',
      'seat',
      'post-capture',
      'push',
      'review',
    ]);
    assert.equal(envelope.steps[2].outcome, 'ran');
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
    assert.equal(envelope.reviewMs, 250);
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
    assert.equal(envelope.steps.at(-1).name, 'credited-run');
  });
});

describe('story-handoff — close-identity deposits and post-capture scoring (Story #5937)', () => {
  const lintHash = hashCommandConfig({
    cmd: 'npm',
    args: ['run', 'lint'],
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
    assert.deepEqual(readState().lintCredit, {
      head: HEAD,
      configHash: lintHash,
    });
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

  test('AC-3: a baselines-only seat commit carries the lint credit to the seated head', async () => {
    const h = harness({
      outputs: {
        'update-crap-baseline.js': { status: 0, stdout: 'seated: 2' },
      },
    });
    const { envelope } = await h.run();
    assert.equal(envelope.headSha, SEATED_HEAD);
    const lintGate = buildDefaultGates({
      config: configFor(),
      baseBranch: 'main',
      cwd: '/work',
      packageScripts: CAPTURE_SCRIPTS,
    }).find((g) => g.name === 'lint');
    const close = await runCloseValidation({
      cwd: tempRoot,
      worktreePath: '/work',
      gates: [lintGate],
      storyId: STORY,
      standalone: true,
      getHeadSha: () => SEATED_HEAD,
      getTreeFingerprint: () => null,
      runner: () => assert.fail('close must not re-run lint'),
      runProjections: async () => {},
    });
    assert.deepEqual(
      close.skipped.map((x) => [x.gate.name, x.reason]),
      [['lint', 'evidence-match']],
    );
    assert.equal(evidenceSkip('format', SEATED_HEAD, lintHash).skip, false);
  });

  test('AC-3: a seat commit touching anything outside baselines/ carries nothing', async () => {
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
  });

  test('AC-4: a CRAP regression in the fresh capture is fix-required and pushes nothing', async () => {
    const h = harness({
      outputs: { 'quality-preview.js --only crap': { status: 1 } },
    });
    const { envelope, exitCode } = await h.run();
    assert.equal(exitCode, 2);
    assert.equal(envelope.failedStep, 'post-capture');
    assert.match(envelope.steps.at(-1).detail, /quality-preview-crap/);
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
      const detail = envelope.steps.at(-1).detail;
      assert.match(detail, new RegExp(`${gate} \\(kinds: ${kind}\\)`));
      assert.ok(!spawned(h.runCommand).includes('git'));
    });
  }

  test('AC-6: post-capture runs once after depositor and seat, lock-free, and skips at an unchanged head', async () => {
    const h = harness({ config: baselinesConfig() });
    h.deps.presentBaselines = ['maintainability', 'crap'];
    const { envelope } = await h.run();
    const post = envelope.steps.find((s) => s.name === 'post-capture');
    assert.equal(post.outcome, 'ran');
    const keys = spawned(h.runCommand);
    assert.deepEqual(
      keys.slice(keys.indexOf('update-maintainability-baseline.js') + 1),
      [
        'quality-preview.js --only crap',
        'check-baselines.js maintainability',
        'check-baselines.js crap',
        'git',
      ],
    );
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
