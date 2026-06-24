import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  isFormatterEligible,
  resolveTypecheckCommand,
} from '../.agents/scripts/lib/close-validation/commands.js';
import {
  buildDefaultGates,
  DEFAULT_GATES,
} from '../.agents/scripts/lib/close-validation/gates.js';
import { isBiomeNoFilesProcessed } from '../.agents/scripts/lib/close-validation/process.js';
import { runCloseValidation as runCloseValidationOnly } from '../.agents/scripts/lib/close-validation/runner.js';
import {
  drainPendingCleanupAfterClose,
  getCloseDrainStatus,
  reconcileCleanupState,
} from '../.agents/scripts/lib/orchestration/story-close/cleanup-reconciler.js';
import {
  buildResumeMergeCommitMsg,
  describeResumePushFailure,
} from '../.agents/scripts/lib/orchestration/story-close/comment-bodies.js';
import { renderCoverageTimeoutFrictionBody } from '../.agents/scripts/story-close.js';

const SCRIPT_PATH = path.resolve('.agents/scripts/story-close.js');

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
  );
  return result;
}

async function withTempGitRepo(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mandrel-story-close-'));
  try {
    runGit(dir, ['init', '-b', 'main']);
    runGit(dir, ['config', 'user.email', 'agent@example.invalid']);
    runGit(dir, ['config', 'user.name', 'Mandrel Agent']);
    writeFileSync(path.join(dir, 'tracked.js'), 'const value = 1;\n');
    runGit(dir, ['add', 'tracked.js']);
    runGit(dir, ['commit', '-m', 'chore: seed repo']);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('buildResumeMergeCommitMsg lower-cases the first letter and tags resolves', () => {
  assert.strictEqual(
    buildResumeMergeCommitMsg(
      'Story 13 — Address top-priority CRAP hotspots',
      792,
    ),
    'feat: story 13 — Address top-priority CRAP hotspots (resolves #792)',
  );
});

test('buildResumeMergeCommitMsg handles already-lowercase titles', () => {
  assert.strictEqual(
    buildResumeMergeCommitMsg('cleanup tickets', 1),
    'feat: cleanup tickets (resolves #1)',
  );
});

test('describeResumePushFailure returns null when push is ok', () => {
  assert.strictEqual(
    describeResumePushFailure({ ok: true, attempts: 1, result: {} }),
    null,
  );
});

test('describeResumePushFailure: retry-exhausted attaches attempts count', () => {
  const out = describeResumePushFailure({
    ok: false,
    reason: 'retry-exhausted',
    attempts: 3,
    result: { stderr: 'remote rejected' },
  });
  assert.match(out, /retries exhausted after 3 attempt\(s\)/);
  assert.match(out, /remote rejected/);
});

test('describeResumePushFailure: other reasons surface raw reason and detail', () => {
  const out = describeResumePushFailure({
    ok: false,
    reason: 'rebase-conflict',
    attempts: 1,
    result: { stdout: 'conflict in foo.js' },
  });
  assert.match(out, /Push failed \(rebase-conflict\)/);
  assert.match(out, /conflict in foo\.js/);
});

test('describeResumePushFailure: missing detail falls back to "unknown"', () => {
  const out = describeResumePushFailure({
    ok: false,
    reason: 'mystery',
    attempts: 1,
    result: {},
  });
  assert.match(out, /unknown/);
});

test('story-close script', async (t) => {
  await t.test('fails without --story argument', () => {
    const result = spawnSync('node', [SCRIPT_PATH]);
    assert.strictEqual(result.status, 1);
    assert.match(
      result.stderr.toString() + result.stdout.toString(),
      /Usage: node story-close\.js --story <STORY_ID>/,
    );
  });
});

test('runCloseValidation', async (t) => {
  await t.test(
    'DEFAULT_GATES covers typecheck, lint, format, coverage-capture, and check-baselines',
    () => {
      // Story #1798: when crap.enabled is true (the framework default), the
      // standalone `test` gate is dropped — coverage-capture carries
      // test-failure signalling. The default-built gate list therefore
      // ships with coverage-capture but NOT a separate `test` entry.
      //
      // Story #2210: the per-kind in-process gates
      // (`check-maintainability` / `check-crap` / `check-mutation`) were
      // retired; the unified `check-baselines` gate is the single source
      // of truth for per-kind regression enforcement.
      const names = DEFAULT_GATES.map((g) => g.name);
      assert.ok(names.includes('typecheck'));
      assert.ok(names.includes('lint'));
      assert.ok(names.includes('format'));
      assert.ok(names.includes('coverage-capture'));
      assert.ok(names.includes('check-baselines'));
      assert.ok(
        !names.includes('test'),
        'standalone `test` gate must be absent in the default (crap.enabled) gate list',
      );
    },
  );

  await t.test(
    'DEFAULT_GATES runs typecheck first so it fast-fails before lint',
    () => {
      assert.equal(DEFAULT_GATES[0].name, 'typecheck');
      const names = DEFAULT_GATES.map((g) => g.name);
      const tcIdx = names.indexOf('typecheck');
      const lintIdx = names.indexOf('lint');
      assert.ok(tcIdx < lintIdx, 'typecheck must run before lint');
    },
  );

  await t.test(
    'legacy `test` gate is preserved when crap.enabled is false',
    () => {
      // Story #1798 / Task #1804: existing-behaviour-preserved leg of the AC.
      // When a consumer explicitly opts out of the CRAP gate, the standalone
      // `test` gate stays in the graph so a fresh Story close still runs the
      // suite via the legacy gate.
      const gates = buildDefaultGates({
        config: {
          delivery: { quality: { gates: { crap: { enabled: false } } } },
        },
      });
      const names = gates.map((g) => g.name);
      assert.ok(
        names.includes('test'),
        `\`test\` gate must be preserved when crap.enabled is false; got: ${names.join(', ')}`,
      );
      // And ordering: typecheck and lint still precede `test`.
      const tcIdx = names.indexOf('typecheck');
      const lintIdx = names.indexOf('lint');
      const testIdx = names.indexOf('test');
      assert.ok(
        tcIdx < lintIdx && lintIdx < testIdx,
        'ordering must remain typecheck → lint → test in the legacy two-gate path',
      );
    },
  );

  await t.test(
    'typecheck gate falls back to `npm run typecheck` when settings is unset',
    () => {
      const gate = DEFAULT_GATES.find((g) => g.name === 'typecheck');
      assert.equal(gate.cmd, 'npm');
      assert.deepStrictEqual(gate.args, ['run', 'typecheck']);
      assert.match(gate.hint, /TypeScript regression/);
    },
  );

  await t.test(
    'typecheck gate honours project.commands.typecheck when configured',
    () => {
      const gates = buildDefaultGates({
        config: {
          project: { commands: { typecheck: 'pnpm exec turbo run typecheck' } },
        },
      });
      const gate = gates.find((g) => g.name === 'typecheck');
      assert.equal(gate.cmd, 'pnpm');
      assert.deepStrictEqual(gate.args, ['exec', 'turbo', 'run', 'typecheck']);
    },
  );

  await t.test('resolveTypecheckCommand resolution rules', () => {
    assert.equal(resolveTypecheckCommand(undefined), 'npm run typecheck');
    assert.equal(resolveTypecheckCommand({}), 'npm run typecheck');
    assert.equal(
      resolveTypecheckCommand({ project: { commands: { typecheck: null } } }),
      'npm run typecheck',
    );
    assert.equal(
      resolveTypecheckCommand({ project: { commands: { typecheck: '   ' } } }),
      'npm run typecheck',
    );
    assert.equal(
      resolveTypecheckCommand({
        project: { commands: { typecheck: 'tsc --noEmit' } },
      }),
      'tsc --noEmit',
    );
  });

  await t.test(
    'a failing typecheck halts runCloseValidation and surfaces the hint',
    async () => {
      const gates = buildDefaultGates();
      const tcArgs = gates[0].args;
      const tcCmd = gates[0].cmd;
      const calls = [];
      const runner = (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === tcCmd && args.join(' ') === tcArgs.join(' ')) {
          return { status: 2 };
        }
        return { status: 0 };
      };
      const logs = [];
      const result = await runCloseValidationOnly({
        cwd: '.',
        gates,
        runner,
        log: (m) => logs.push(m),
      });
      assert.equal(result.ok, false);
      assert.equal(result.failed.length, 1);
      assert.equal(result.failed[0].gate.name, 'typecheck');
      // Independent gates (typecheck/lint/format) start in parallel — the
      // typecheck failure aborts the wave before the serial phase begins,
      // so the serial gates (test / coverage-capture / check-baselines)
      // must not have run.
      const serialNames = new Set([
        'test',
        'coverage-capture',
        'check-baselines',
      ]);
      const serialCalls = calls.filter((c) => {
        const matched = gates.find(
          (g) => g.cmd === c.cmd && g.args.join(' ') === c.args.join(' '),
        );
        return matched && serialNames.has(matched.name);
      });
      assert.equal(
        serialCalls.length,
        0,
        'should halt before running any serial gate (test/coverage/baselines)',
      );
      assert.ok(logs.some((m) => /TypeScript regression/.test(m)));
    },
  );

  await t.test(
    'format gate defaults to biome and surfaces the --write hint',
    () => {
      const gate = DEFAULT_GATES.find((g) => g.name === 'format');
      assert.equal(gate.cmd, 'npx');
      assert.deepStrictEqual(gate.args, ['biome', 'format', '.']);
      assert.match(gate.hint, /biome format --write/);
    },
  );

  await t.test(
    'default biome format gate scopes execution to changed files when a baseline ref is available',
    async () =>
      withTempGitRepo(async (repoDir) => {
        runGit(repoDir, ['switch', '-c', 'story-3407']);
        writeFileSync(path.join(repoDir, 'tracked.js'), 'const value = 2;\n');
        runGit(repoDir, ['add', 'tracked.js']);
        runGit(repoDir, ['commit', '-m', 'fix: update tracked file']);

        const gate = buildDefaultGates({ epicBranch: 'main' }).find(
          (g) => g.name === 'format',
        );
        const calls = [];
        const result = await runCloseValidationOnly({
          cwd: repoDir,
          gates: [gate],
          runner: (cmd, args) => {
            calls.push({ cmd, args });
            return { status: 0 };
          },
          log: () => {},
        });

        assert.equal(result.ok, true);
        assert.deepStrictEqual(calls, [
          {
            cmd: 'npx',
            args: ['biome', 'format', 'tracked.js'],
          },
        ]);
      }),
  );

  await t.test(
    'default biome format gate skips instead of running dot when the story diff is empty',
    async () =>
      withTempGitRepo(async (repoDir) => {
        runGit(repoDir, ['switch', '-c', 'story-3407']);

        const gate = buildDefaultGates({ epicBranch: 'main' }).find(
          (g) => g.name === 'format',
        );
        const calls = [];
        const result = await runCloseValidationOnly({
          cwd: repoDir,
          gates: [gate],
          runner: (cmd, args) => {
            calls.push({ cmd, args });
            return { status: 0 };
          },
          log: () => {},
        });

        assert.equal(result.ok, true);
        assert.deepStrictEqual(result.skipped, [
          { gate, reason: 'no-changed-files' },
        ]);
        assert.deepStrictEqual(calls, []);
      }),
  );

  await t.test(
    'default biome format gate skips when the diff contains only formatter-ineligible files (docs-only Story)',
    async () =>
      withTempGitRepo(async (repoDir) => {
        runGit(repoDir, ['switch', '-c', 'story-3410']);
        writeFileSync(
          path.join(repoDir, 'docs.md'),
          '# Docs\n\nNew section.\n',
        );
        runGit(repoDir, ['add', 'docs.md']);
        runGit(repoDir, ['commit', '-m', 'docs: add a section']);

        const gate = buildDefaultGates({ epicBranch: 'main' }).find(
          (g) => g.name === 'format',
        );
        const calls = [];
        const result = await runCloseValidationOnly({
          cwd: repoDir,
          gates: [gate],
          runner: (cmd, args) => {
            calls.push({ cmd, args });
            return { status: 0 };
          },
          log: () => {},
        });

        assert.equal(result.ok, true);
        assert.deepStrictEqual(result.skipped, [
          { gate, reason: 'no-changed-files' },
        ]);
        assert.deepStrictEqual(
          calls,
          [],
          'biome must not be invoked with only ineligible (.md) paths',
        );
      }),
  );

  await t.test(
    'default biome format gate scopes to the eligible subset when the diff mixes eligible and ineligible files',
    async () =>
      withTempGitRepo(async (repoDir) => {
        runGit(repoDir, ['switch', '-c', 'story-3410']);
        writeFileSync(path.join(repoDir, 'src.ts'), 'export const x = 1;\n');
        writeFileSync(path.join(repoDir, 'notes.md'), '# Notes\n');
        writeFileSync(path.join(repoDir, 'data.json'), '{ "a": 1 }\n');
        runGit(repoDir, ['add', 'src.ts', 'notes.md', 'data.json']);
        runGit(repoDir, ['commit', '-m', 'feat: mixed change']);

        const gate = buildDefaultGates({ epicBranch: 'main' }).find(
          (g) => g.name === 'format',
        );
        const calls = [];
        const result = await runCloseValidationOnly({
          cwd: repoDir,
          gates: [gate],
          runner: (cmd, args) => {
            calls.push({ cmd, args });
            return { status: 0 };
          },
          log: () => {},
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, 'npx');
        // Only the biome-eligible paths reach the formatter; .md is dropped.
        const appended = calls[0].args.slice(2).sort();
        assert.deepStrictEqual(appended, ['data.json', 'src.ts']);
      }),
  );

  await t.test(
    'isFormatterEligible classifies biome-eligible extensions',
    () => {
      for (const p of [
        'a.ts',
        'b.tsx',
        'c.js',
        'd.jsx',
        'e.mjs',
        'f.cjs',
        'g.json',
        'h.jsonc',
        'i.css',
        'nested/dir/j.ts',
      ]) {
        assert.equal(isFormatterEligible(p), true, `${p} should be eligible`);
      }
      for (const p of [
        'README.md',
        'docs/decisions.md',
        'config.yaml',
        'config.yml',
        'notes.txt',
        'image.png',
        'Makefile',
        'noext',
      ]) {
        assert.equal(
          isFormatterEligible(p),
          false,
          `${p} should be ineligible`,
        );
      }
    },
  );

  // ── Story #4292 — biome "No files were processed" false-negative guard ──
  // The extension filter cannot see biome's own config-ignore axis. When every
  // eligible-by-extension changed file is also biome-config-ignored, the scoped
  // biome invocation exits 1 with "No files were processed in the specified
  // paths" even though `biome format .` over the tree is clean. The chosen fix
  // (option 2) downgrades that specific exit to a clean pass.

  await t.test(
    "isBiomeNoFilesProcessed detects biome's zero-files marker and ignores unrelated output",
    () => {
      assert.equal(
        isBiomeNoFilesProcessed(
          '× No files were processed in the specified paths.\n',
        ),
        true,
      );
      assert.equal(
        isBiomeNoFilesProcessed(
          '[format] No files were processed in the specified paths',
        ),
        true,
      );
      assert.equal(
        isBiomeNoFilesProcessed('Formatting drift in data.json'),
        false,
      );
      assert.equal(isBiomeNoFilesProcessed(''), false);
      assert.equal(isBiomeNoFilesProcessed(undefined), false);
    },
  );

  // A stub formatter that mimics the slice of biome behaviour under test: when
  // every path it is handed is in its config-ignore set, it prints biome's
  // exact "No files were processed" line and exits 1; when handed a path that
  // carries a "DRIFT" marker it exits 1 with a drift message; otherwise it
  // exits 0. Used to exercise the real `defaultGateRunner` end to end.
  const writeBiomeStub = (repoDir, ignoredFiles) => {
    const stubPath = path.join(repoDir, 'biome-stub.cjs');
    writeFileSync(
      stubPath,
      [
        'const fs = require("node:fs");',
        `const ignored = new Set(${JSON.stringify(ignoredFiles)});`,
        '// args after the leading "format" token are the scoped file paths.',
        'const files = process.argv.slice(3);',
        'const processed = files.filter((f) => !ignored.has(f));',
        'if (processed.length === 0) {',
        '  process.stderr.write("× No files were processed in the specified paths.\\n");',
        '  process.exit(1);',
        '}',
        'for (const f of processed) {',
        '  const body = fs.readFileSync(f, "utf8");',
        '  if (body.includes("DRIFT")) {',
        '    process.stderr.write("Formatter would reformat " + f + "\\n");',
        '    process.exit(1);',
        '  }',
        '}',
        'process.exit(0);',
      ].join('\n'),
    );
    return stubPath;
  };

  const formatGateOverStub = (stubPath) => {
    const gate = buildDefaultGates({ epicBranch: 'main' }).find(
      (g) => g.name === 'format',
    );
    // Repoint the gate's command at the stub while keeping the trailing "."
    // so `applyChangedFileScope` strips it and appends the eligible paths.
    return { ...gate, cmd: process.execPath, args: [stubPath, 'format', '.'] };
  };

  await t.test(
    'format gate passes (not fails) when every eligible changed file is biome-config-ignored (Story #4292)',
    async () =>
      withTempGitRepo(async (repoDir) => {
        runGit(repoDir, ['switch', '-c', 'story-4292']);
        // Two formatter-eligible-by-extension files, both config-ignored by
        // the stub — the exact athportal failure shape (root-config-only diff).
        mkdirSync(path.join(repoDir, 'baselines'), { recursive: true });
        writeFileSync(path.join(repoDir, '.agentrc.json'), '{ "a": 1 }\n');
        writeFileSync(
          path.join(repoDir, 'baselines', 'bundle-size.json'),
          '{}\n',
        );
        runGit(repoDir, ['add', '.agentrc.json', 'baselines/bundle-size.json']);
        runGit(repoDir, ['commit', '-m', 'chore: root config + baseline']);

        const stub = writeBiomeStub(repoDir, [
          '.agentrc.json',
          'baselines/bundle-size.json',
          // the stub itself + git plumbing never reach the gate, but list
          // them defensively so any stray path is treated as ignored.
          'biome-stub.cjs',
        ]);
        const gate = formatGateOverStub(stub);

        const result = await runCloseValidationOnly({
          cwd: repoDir,
          gates: [gate],
          // No injected runner → exercises the real defaultGateRunner, which
          // owns the "No files were processed" downgrade.
          log: () => {},
        });

        assert.equal(
          result.ok,
          true,
          'all-config-ignored eligible diff must not fail the format gate',
        );
        assert.equal(result.failed.length, 0);
      }),
  );

  await t.test(
    'format gate still FAILS on real drift in a config-included file (Story #4292 — no blanket pass)',
    async () =>
      withTempGitRepo(async (repoDir) => {
        runGit(repoDir, ['switch', '-c', 'story-4292-drift']);
        // A config-included (.json, NOT in the stub's ignore set) file that
        // carries the DRIFT marker — the stub exits 1 with a drift message,
        // and the gate must surface that as a real failure.
        writeFileSync(
          path.join(repoDir, 'included.json'),
          '{ "DRIFT": true }\n',
        );
        runGit(repoDir, ['add', 'included.json']);
        runGit(repoDir, ['commit', '-m', 'feat: included config']);

        const stub = writeBiomeStub(repoDir, ['biome-stub.cjs']);
        const gate = formatGateOverStub(stub);

        const result = await runCloseValidationOnly({
          cwd: repoDir,
          gates: [gate],
          log: () => {},
        });

        assert.equal(
          result.ok,
          false,
          'genuine formatting drift in a config-included file must fail the gate',
        );
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].gate.name, 'format');
      }),
  );

  await t.test(
    'format gate honours project.commands.formatCheck / formatWrite',
    () => {
      const gates = buildDefaultGates({
        config: {
          project: {
            commands: {
              formatCheck: 'pnpm exec prettier --check .',
              formatWrite: 'pnpm exec prettier --write .',
            },
          },
        },
      });
      const gate = gates.find((g) => g.name === 'format');
      assert.equal(gate.cmd, 'pnpm');
      assert.deepStrictEqual(gate.args, ['exec', 'prettier', '--check', '.']);
      assert.match(gate.hint, /pnpm exec prettier --write \./);
    },
  );

  // Story #2210 — the legacy `check-maintainability` and `check-crap` per-kind
  // in-process regression gates were retired. The unified `check-baselines`
  // gate is the single source of truth for per-kind regression enforcement,
  // and its hint references `baseline-refresh:` so the operator-facing
  // remediation contract is preserved.
  await t.test(
    'unified check-baselines gate is registered and surfaces the baseline-refresh hint',
    () => {
      const gate = DEFAULT_GATES.find((g) => g.name === 'check-baselines');
      assert.ok(
        gate,
        'unified `check-baselines` gate must be present in DEFAULT_GATES',
      );
      assert.equal(gate.cmd, 'node');
      assert.deepStrictEqual(gate.args, [
        '.agents/scripts/check-baselines.js',
        '--format',
        'text',
      ]);
      assert.match(gate.hint, /baseline-refresh:/);
    },
  );

  await t.test(
    'retired per-kind in-process gates are absent from DEFAULT_GATES (Story #2210)',
    () => {
      const names = DEFAULT_GATES.map((g) => g.name);
      const retired = ['check-maintainability', 'check-crap', 'check-mutation'];
      for (const name of retired) {
        assert.ok(
          !names.includes(name),
          `Retired gate \`${name}\` must not be registered in DEFAULT_GATES; got: ${names.join(', ')}`,
        );
      }
    },
  );

  await t.test('returns ok when every gate exits 0', async () => {
    const calls = [];
    const runner = (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    };
    const gates = [
      { name: 'a', cmd: 'a', args: [] },
      { name: 'b', cmd: 'b', args: [] },
    ];
    const result = await runCloseValidationOnly({ cwd: '.', gates, runner });
    assert.deepEqual(result, { ok: true, failed: [], skipped: [] });
    assert.equal(calls.length, 2);
  });

  await t.test('stops and reports on first non-zero gate', async () => {
    const runner = (cmd) => ({ status: cmd === 'a' ? 0 : 3 });
    const gates = [
      { name: 'a', cmd: 'a', args: [] },
      { name: 'b', cmd: 'b', args: [], hint: 'fix it' },
      { name: 'c', cmd: 'c', args: [] },
    ];
    const logs = [];
    const result = await runCloseValidationOnly({
      cwd: '.',
      gates,
      runner,
      log: (m) => logs.push(m),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].gate.name, 'b');
    assert.equal(result.failed[0].status, 3);
    assert.ok(logs.some((m) => m.includes('hint: fix it')));
  });
});

test('reconcileCleanupState marks deferred worktree cleanup as removed-after-drain and updates branch deletion flags', () => {
  const result = reconcileCleanupState({
    storyId: 795,
    worktreeReap: {
      status: 'deferred-to-sweep',
      path: '/repo/.worktrees/story-795',
      pendingCleanup: { storyId: 795, branch: 'story-795' },
    },
    branchCleanup: {
      localDeleted: false,
      remoteDeleted: true,
      localReason: 'error',
      remoteReason: 'deleted',
    },
    pendingCleanupDrain: {
      drained: [795],
      drainedDetails: [
        {
          storyId: 795,
          path: '/repo/.worktrees/story-795',
          branch: 'story-795',
          localBranchDeleted: true,
          remoteBranchDeleted: true,
        },
      ],
      persistent: [],
      persistentDetails: [],
      stillPending: [],
      stillPendingDetails: [],
    },
  });
  assert.equal(result.worktreeReap.status, 'removed-after-drain');
  assert.equal(result.worktreeReap.closeDrainStatus, 'drained');
  assert.equal(result.worktreeReap.pendingCleanup, null);
  assert.equal(result.branchCleanup.localDeleted, true);
  assert.equal(result.branchCleanup.remoteDeleted, true);
});

test('getCloseDrainStatus covers the persistent / still-pending / not-found truth table', () => {
  // persistent wins over still-pending — operator action is the authoritative outcome
  assert.equal(
    getCloseDrainStatus({ isPersistent: true, isStillPending: true }),
    'persistent',
  );
  assert.equal(
    getCloseDrainStatus({ isPersistent: true, isStillPending: false }),
    'persistent',
  );
  assert.equal(
    getCloseDrainStatus({ isPersistent: false, isStillPending: true }),
    'still-pending',
  );
  assert.equal(
    getCloseDrainStatus({ isPersistent: false, isStillPending: false }),
    'not-found',
  );
});

test('reconcileCleanupState marks the deferred worktree as persistent when the drain hit the persistent-lock threshold', () => {
  const result = reconcileCleanupState({
    storyId: 808,
    worktreeReap: {
      status: 'deferred-to-sweep',
      path: '/repo/.worktrees/story-808',
      pendingCleanup: { storyId: 808, branch: 'story-808' },
    },
    branchCleanup: {
      localDeleted: false,
      remoteDeleted: true,
      localReason: 'error',
      remoteReason: 'deleted',
    },
    pendingCleanupDrain: {
      drained: [],
      drainedDetails: [],
      persistent: [808],
      persistentDetails: [{ storyId: 808 }],
      stillPending: [],
      stillPendingDetails: [],
    },
  });
  assert.equal(result.worktreeReap.status, 'deferred-to-sweep');
  assert.equal(result.worktreeReap.closeDrainStatus, 'persistent');
});

test('reconcileCleanupState preserves deferred state when the close-time drain still cannot clear the lock', () => {
  const result = reconcileCleanupState({
    storyId: 795,
    worktreeReap: {
      status: 'deferred-to-sweep',
      path: '/repo/.worktrees/story-795',
      pendingCleanup: { storyId: 795, branch: 'story-795' },
    },
    branchCleanup: {
      localDeleted: false,
      remoteDeleted: true,
      localReason: 'error',
      remoteReason: 'deleted',
    },
    pendingCleanupDrain: {
      drained: [],
      drainedDetails: [],
      persistent: [],
      persistentDetails: [],
      stillPending: [795],
      stillPendingDetails: [{ storyId: 795 }],
    },
  });
  assert.equal(result.worktreeReap.status, 'deferred-to-sweep');
  assert.equal(result.worktreeReap.closeDrainStatus, 'still-pending');
  assert.equal(result.branchCleanup.localDeleted, false);
  assert.equal(result.branchCleanup.remoteDeleted, true);
});

test('drainPendingCleanupAfterClose returns null when worktree isolation is disabled', async () => {
  const res = await drainPendingCleanupAfterClose({
    repoRoot: '.',
    delivery: { worktreeIsolation: { enabled: false } },
  });
  assert.equal(res, null);
});

test('drainPendingCleanupAfterClose reports the worktree root and drain summary', async () => {
  const events = [];
  const res = await drainPendingCleanupAfterClose({
    repoRoot: '/repo',
    delivery: { worktreeIsolation: { enabled: true, root: '.worktrees' } },
    progress: (phase, msg) => events.push({ phase, msg }),
    drainFn: async () => ({
      drained: [795],
      drainedDetails: [{ storyId: 795, localBranchDeleted: true }],
      persistent: [],
      persistentDetails: [],
      stillPending: [],
      stillPendingDetails: [],
    }),
  });
  assert.equal(res.worktreeRoot, path.join('/repo', '.worktrees'));
  assert.deepEqual(res.drained, [795]);
  assert.ok(
    events.some(
      (e) =>
        e.phase === 'WORKTREE' &&
        e.msg.includes('Pending cleanup drain: drained=1'),
    ),
  );
});

test('renderCoverageTimeoutFrictionBody names the timeout duration and IDs (#2136)', () => {
  const body = renderCoverageTimeoutFrictionBody({
    storyId: 2136,
    epicId: 2129,
    timeoutMs: 600_000,
  });
  assert.match(body, /Coverage capture timed out/);
  assert.match(body, /Story #2136/);
  assert.match(body, /Epic #2129/);
  assert.match(body, /600000ms/);
  assert.match(body, /Exit code:.*124/);
  assert.match(body, /agent::blocked/);
  assert.match(body, /delivery\.quality\.gates\.coverage\.timeoutMs/);
});

test('renderCoverageTimeoutFrictionBody falls back to "configured budget" when timeoutMs is missing', () => {
  const body = renderCoverageTimeoutFrictionBody({
    storyId: 1,
    epicId: 2,
    timeoutMs: null,
  });
  assert.match(body, /configured budget/);
});
