import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pickSpawnShape,
  runLintBaselineCli,
} from '../.agents/scripts/lint-baseline.js';

/**
 * Story #2750 — Windows pre-push: `lint-baseline.js check` ignored the
 * `.agentrc.json` override and crashed on the default `npx eslint`
 * because `spawnSync({ shell: false })` cannot resolve Windows `.cmd`
 * shims. These tests pin both regressions closed:
 *
 *   1. `pickSpawnShape` enables `shell: true` for shim launchers
 *      (`npx`, `npm`, `pnpm`, `pnpx`, `yarn`) and uses `shell: false`
 *      with parsed argv for everything else.
 *   2. `runLintBaselineCli` reads `project.commands.lintBaseline` from
 *      the resolved config (Bug 1: the previous call site passed
 *      `{ agentSettings }` and `getCommands` reads `project.commands`,
 *      so every operator override was silently dropped to defaults).
 */

/* --------------------------------------------------------------------- */
/* Bug 2 — shim-launcher spawn shape                                     */
/* --------------------------------------------------------------------- */

test('pickSpawnShape — npx commands route through shell:true with full string', () => {
  const shape = pickSpawnShape('npx eslint . --format json');
  assert.equal(shape.shell, true);
  assert.equal(shape.command, 'npx eslint . --format json');
  assert.deepEqual(shape.args, []);
});

test('pickSpawnShape — npm/pnpm/pnpx/yarn are all treated as shim launchers', () => {
  for (const head of ['npm', 'pnpm', 'pnpx', 'yarn']) {
    const shape = pickSpawnShape(`${head} run lint`);
    assert.equal(shape.shell, true, `${head} should use shell:true`);
    assert.equal(shape.command, `${head} run lint`);
    assert.deepEqual(shape.args, []);
  }
});

test('pickSpawnShape — node and other bare binaries use shell:false with parsed argv', () => {
  const shape = pickSpawnShape('node scripts/lint.js --format json');
  assert.equal(shape.shell, false);
  assert.equal(shape.command, 'node');
  assert.deepEqual(shape.args, ['scripts/lint.js', '--format', 'json']);
});

test('pickSpawnShape — empty string returns the empty-command sentinel', () => {
  const shape = pickSpawnShape('');
  assert.equal(shape.shell, false);
  assert.equal(shape.command, '');
  assert.deepEqual(shape.args, []);
});

test('pickSpawnShape — shim head with quoted args preserves quoting via shell', () => {
  const shape = pickSpawnShape('npx eslint "src/foo bar.js" --format json');
  assert.equal(shape.shell, true);
  // Whole string is handed to the shell — no argv parsing on this path.
  assert.equal(shape.command, 'npx eslint "src/foo bar.js" --format json');
});

/* --------------------------------------------------------------------- */
/* Bug 1 — runLintBaselineCli honors project.commands.lintBaseline       */
/* --------------------------------------------------------------------- */

function fakeRunners(captured) {
  // The runner only needs to record cmdConfig and return a non-degraded
  // envelope — we are testing the config-resolution path, not the
  // ESLint invocation.
  const sink = (cmdConfig) => {
    captured.push(cmdConfig);
    return { errorCount: 0, warningCount: 0 };
  };
  return { capture: sink, check: sink, diff: sink };
}

test('runLintBaselineCli — operator override on project.commands.lintBaseline is honored', async () => {
  const captured = [];
  const result = await runLintBaselineCli(
    { mode: 'check', gateModeArgv: [] },
    {
      resolveConfig: () => ({
        project: {
          commands: { lintBaseline: 'node scripts/custom-lint.mjs' },
          baselines: { lint: { path: 'baselines/lint.json' } },
        },
        agentSettings: {},
      }),
      runners: fakeRunners(captured),
      projectRoot: '/tmp',
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0], 'node scripts/custom-lint.mjs');
});

test('runLintBaselineCli — falls back to framework default when override is absent', async () => {
  const captured = [];
  await runLintBaselineCli(
    { mode: 'check', gateModeArgv: [] },
    {
      resolveConfig: () => ({
        project: {
          commands: {},
          baselines: { lint: { path: 'baselines/lint.json' } },
        },
        agentSettings: {},
      }),
      runners: fakeRunners(captured),
      projectRoot: '/tmp',
    },
  );
  assert.equal(captured.length, 1);
  // The framework default — sourced from COMMANDS_DEFAULTS.lintBaseline.
  assert.equal(captured[0], 'npx eslint . --format json');
});

test('runLintBaselineCli — validation-error when mode is unknown', async () => {
  const result = await runLintBaselineCli(
    { mode: 'banana', gateModeArgv: [] },
    {
      resolveConfig: () => ({ project: {}, agentSettings: {} }),
      runners: fakeRunners([]),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.result.kind, 'validation-error');
});
