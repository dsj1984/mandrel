/**
 * Story #5471 — a close gate's exit code maps to what happened, not always to
 * "failed". `75` is an expired full-suite lock wait (nothing ran), `124` a
 * suite killed on timeout (no verdict), and anything else a real failure.
 * Each outcome logs its own line; only a real failure prints the gate's own
 * (failing-tests) hint, and every `failed[]` entry carries its `outcome`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { defaultGateRunner } from '../../../.agents/scripts/lib/close-validation/process.js';
import { runCloseValidation } from '../../../.agents/scripts/lib/close-validation/runner.js';
import { runCloseValidationPhase } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/close-validation.js';
import { PROJECT_ROOT } from '../../../.agents/scripts/lib/project-root.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const FAILING_TESTS_HINT =
  'Coverage capture failed — `npm run test:coverage` exited non-zero. Fix failing tests or coverage-threshold breaches, then re-run close.';

/** A serial gate (coverage-capture) and a parallel one (lint). */
const GATES = {
  serial: {
    name: 'coverage-capture',
    cmd: 'node',
    args: ['.agents/scripts/coverage-capture.js'],
    hint: FAILING_TESTS_HINT,
  },
  parallel: {
    name: 'lint',
    cmd: 'npm',
    args: ['run', 'lint'],
    hint: 'lint hint',
  },
};

async function closeWith(gate, status) {
  const lines = [];
  const result = await runCloseValidation({
    cwd: '/repo',
    gates: [gate],
    useEvidence: false,
    runner: async () => ({ status }),
    log: (m) => lines.push(m),
  });
  return { result, lines, text: lines.join('\n') };
}

for (const [partition, gate] of Object.entries(GATES)) {
  describe(`gate exit outcomes — ${partition} gate (${gate.name})`, () => {
    it('AC-3: exit 75 logs a deferred line, never the failed line or the gate hint', async () => {
      const { result, text } = await closeWith(gate, 75);
      assert.equal(result.ok, false);
      assert.equal(result.failed.length, 1);
      const [entry] = result.failed;
      assert.equal(entry.status, 75);
      assert.equal(entry.outcome, 'deferred');
      assert.equal(entry.gate.name, gate.name);
      assert.equal(entry.gate.hint, undefined);
      assert.match(text, new RegExp(`⏸ ${gate.name} deferred \\(exit 75\\)`));
      assert.match(text, /lock wait expired/);
      assert.doesNotMatch(text, /✖/);
      assert.ok(!text.includes(gate.hint), text);
    });

    it('AC-4: exit 124 logs a timeout line with the timeout hint, never the gate hint', async () => {
      const { result, text } = await closeWith(gate, 124);
      const [entry] = result.failed;
      assert.equal(entry.outcome, 'timeout');
      assert.equal(entry.status, 124);
      assert.match(text, new RegExp(`⏱ ${gate.name} timed out \\(exit 124\\)`));
      assert.match(text, /delivery\.quality\.gates\.coverage\.timeoutMs/);
      assert.match(text, /host contention/);
      assert.doesNotMatch(text, /✖/);
      assert.ok(!text.includes(gate.hint), text);
      assert.match(entry.gate.hint, /timeoutMs/);
    });

    it('AC-4: exit 1 keeps the failed line and the gate hint', async () => {
      const { result, text } = await closeWith(gate, 1);
      const [entry] = result.failed;
      assert.equal(entry.outcome, 'failed');
      assert.equal(entry.gate.hint, gate.hint);
      assert.match(text, new RegExp(`✖ ${gate.name} failed \\(exit 1\\)`));
      assert.ok(text.includes(`hint: ${gate.hint}`), text);
    });
  });
}

describe('gate exit outcomes — the close phase settles them', () => {
  const phaseWith = (status, lockOutcome) =>
    runCloseValidationPhase({
      cwd: '/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyId: 5471,
      progress: () => {},
      buildDefaultGates: () => [GATES.serial],
      runPreGateSteps: async () => {},
      runCloseValidation: (opts) =>
        runCloseValidation({
          ...opts,
          useEvidence: false,
          runner: async (_cmd, _args, { onLockEvent }) => {
            if (lockOutcome) onLockEvent({ kind: 'lock-wait', ...lockOutcome });
            return { status };
          },
        }),
    });

  it('AC-3: an expired lock wait with exit 75 settles pending, not failed', async () => {
    const settled = await phaseWith(75, { waitedSeconds: 900, expired: true });
    assert.equal(settled.pending, true);
    assert.equal(settled.gates, null);
    assert.equal(settled.lockWait.expired, true);
  });

  it('AC-4: a timed-out gate fails close naming the timeout, not failing tests', async () => {
    await assert.rejects(phaseWith(124), (err) => {
      assert.equal(err.closeGate, 'coverage-capture');
      assert.match(err.message, /exit 124/);
      assert.match(err.message, /timeoutMs/);
      assert.doesNotMatch(err.message, /Fix failing tests/);
      return true;
    });
  });
});

describe('gate children resolve config from their cwd (#5729)', () => {
  const PRINT_AGENTRC_CWD = [
    '-e',
    'process.stdout.write(String(process.env.AP_AGENTRC_CWD))',
  ];

  async function spawnedAgentrcCwd(opts) {
    const lines = [];
    const { status } = await defaultGateRunner(
      process.execPath,
      PRINT_AGENTRC_CWD,
      { ...opts, log: (m) => lines.push(m) },
    );
    assert.equal(status, 0);
    return lines.join('\n');
  }

  let cwd;
  let inherited;
  beforeEach(() => {
    cwd = makeTempDir('mandrel-gate-env-');
    inherited = process.env.AP_AGENTRC_CWD;
    process.env.AP_AGENTRC_CWD = '/main-checkout';
  });
  afterEach(() => {
    if (inherited === undefined) delete process.env.AP_AGENTRC_CWD;
    else process.env.AP_AGENTRC_CWD = inherited;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('AC-2: a gate spawned with no supervision env gets AP_AGENTRC_CWD = its cwd', async () => {
    assert.equal(await spawnedAgentrcCwd({ cwd }), cwd);
  });

  it('AC-2: a supplied env cannot override the cwd pin', async () => {
    const env = { AP_AGENTRC_CWD: '/elsewhere', GATE_ONLY: '1' };
    assert.equal(await spawnedAgentrcCwd({ cwd, env }), cwd);
  });
});

describe('a gate child anchors config on its own tree with no env var (#5740)', () => {
  const RESOLVER = pathToFileURL(
    path.join(PROJECT_ROOT, '.agents/scripts/lib/config-resolver.js'),
  ).href;
  const PRINT_CONFIG = [
    '--input-type=module',
    '-e',
    `import { resolveConfig } from ${JSON.stringify(RESOLVER)};
const c = resolveConfig();
process.stdout.write(JSON.stringify({ source: c.source, baseBranch: c.project.baseBranch }));`,
  ];

  function envWithout(extra = {}) {
    const env = { ...process.env, ...extra };
    if (!('AP_AGENTRC_CWD' in extra)) delete env.AP_AGENTRC_CWD;
    return env;
  }

  function resolvedIn(cwd, env) {
    return JSON.parse(
      execFileSync(process.execPath, PRINT_CONFIG, {
        cwd,
        env,
        encoding: 'utf8',
      }),
    );
  }

  /** A git work tree whose `.agentrc.json` names `baseBranch`. */
  function treeWith(baseBranch) {
    const dir = realpathSync.native(makeTempDir('mandrel-anchor-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(
      path.join(dir, '.agentrc.json'),
      JSON.stringify({
        project: {
          baseBranch,
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
      }),
    );
    return dir;
  }

  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC-1: a child spawned with cwd = a worktree, AP_AGENTRC_CWD unset, reads that worktree .agentrc.json', () => {
    const worktree = treeWith('worktree-base');
    made.push(worktree);
    const sub = path.join(worktree, 'nested');
    mkdirSync(sub);
    const got = resolvedIn(sub, envWithout());
    assert.equal(got.baseBranch, 'worktree-base');
    assert.equal(got.source, path.join(worktree, '.agentrc.json'));
  });

  it('a linked worktree without the gitignored overlay takes the main checkout overlay', () => {
    const main = treeWith('committed-base');
    made.push(main);
    const git = (...args) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        { cwd: main, stdio: 'pipe' },
      );
    writeFileSync(path.join(main, '.gitignore'), '.agentrc.local.json\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    writeFileSync(
      path.join(main, '.agentrc.local.json'),
      JSON.stringify({ project: { baseBranch: 'local-base' } }),
    );
    const worktree = path.join(main, '.worktrees', 'story-1');
    git('worktree', 'add', '-q', worktree);
    const got = resolvedIn(worktree, envWithout());
    assert.equal(got.baseBranch, 'local-base');
    assert.match(got.source, /overrides .*story-1/);
  });

  it('AC-1: an explicit AP_AGENTRC_CWD still overrides the cwd tree', () => {
    const worktree = treeWith('worktree-base');
    const other = treeWith('override-base');
    made.push(worktree, other);
    const got = resolvedIn(worktree, envWithout({ AP_AGENTRC_CWD: other }));
    assert.equal(got.baseBranch, 'override-base');
  });

  it('AC-1: a non-git temp directory falls back to PROJECT_ROOT', () => {
    const plain = realpathSync.native(makeTempDir('mandrel-anchor-plain-'));
    made.push(plain);
    const got = resolvedIn(plain, envWithout());
    assert.ok(
      got.source.includes(path.join(PROJECT_ROOT, '.agentrc')),
      got.source,
    );
  });
});
