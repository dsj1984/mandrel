// tests/lib/baselines/scope-assert.test.js
/**
 * Story #5012 — the both-directions row-set assertion and its merge-base
 * attribution.
 *
 * Three properties are pinned here, each answering a way the gate could be
 * worse than useless:
 *
 *  1. **Both directions, or the gate is half-blind.** A row pointing at a
 *     deleted file and an in-scope file carrying no row are the same defect
 *     seen from either end; checking only one leaves the other invisible.
 *
 *  2. **Sparse kinds never report phantom MISSING rows.** Measured against
 *     this repository on 2026-08-05, asserting MISSING densely produces 128
 *     phantom findings for `crap` and 510 for `duplication` on a perfectly
 *     healthy tree. A gate that cries 638 times is a gate nobody reads, so the
 *     direction is gated on the producer's density, not on caution.
 *
 *  3. **Attribution, or every open PR reds.** Whole-tree equality on the PR
 *     path fails the moment anyone lands an in-scope file. Only divergence
 *     attributable to `merge-base(base, HEAD)..HEAD` may block — and the
 *     resolution fails towards strict whenever the diff can no longer explain
 *     the divergence.
 *
 * The module under test is pure, so the first three suites run on hand-built
 * inputs — no fixture repository, no git, no filesystem. The last two spawn
 * `check-baseline-scope.js`, because the exit code is what a required CI check
 * consumes and attribution only becomes observable once real git history sits
 * underneath it.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { currentKernelVersion } from '../../../.agents/scripts/lib/baselines/kernel.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import {
  formatReport,
  runScopeCheck,
} from '../../../scripts/check-baseline-scope.js';
import {
  assertScope,
  attributeDivergence,
  EXTRA_REASONS,
  resolveStrictness,
  STRICT_REASONS,
} from '../../../scripts/lib/baselines/scope-assert.js';
import {
  directionsFor,
  KIND_SCOPE_POLICY,
} from '../../../scripts/lib/baselines/scope-inventory.js';
import { seedGitIdentity } from '../../fixtures/git-fixture.js';

/**
 * Build an inventory record of the shape `buildScopeInventory` returns,
 * without touching a filesystem.
 *
 * @param {{ kind?: string, files: string[] | null, directions?: string[],
 *   keyField?: string, degraded?: boolean, reason?: string | null }} spec
 * @returns {object}
 */
function inventoryOf({
  kind = 'maintainability',
  files,
  directions = ['missing', 'extra'],
  keyField = 'path',
  degraded = false,
  reason = null,
}) {
  return { kind, keyField, directions, files, degraded, reason };
}

describe('assertScope — both directions (Story #5012 AC-2)', () => {
  test('an in-scope file with no row is reported as missing', () => {
    const found = assertScope({
      inventory: inventoryOf({ files: ['src/a.js', 'src/unmeasured.js'] }),
      rows: [{ path: 'src/a.js', mi: 90 }],
    });

    assert.deepEqual(found.missing, ['src/unmeasured.js']);
    assert.deepEqual(found.extra, []);
  });

  test('a row whose file is gone from disk is reported as extra/absent', () => {
    const found = assertScope({
      inventory: inventoryOf({ files: ['src/a.js'] }),
      rows: [
        { path: 'src/a.js', mi: 90 },
        { path: 'src/deleted.js', mi: 88 },
      ],
      existsOnDisk: (file) => file !== 'src/deleted.js',
    });

    assert.deepEqual(found.missing, []);
    assert.deepEqual(found.extra, [
      { path: 'src/deleted.js', reason: EXTRA_REASONS.ABSENT },
    ]);
  });

  test('a row whose file left the gate scope is reported as extra/out-of-scope', () => {
    // Same input as above except the file is still on disk — the distinction
    // matters because the two classes have different remedies: restore or
    // re-measure for one, prune for the other.
    const found = assertScope({
      inventory: inventoryOf({ files: ['src/a.js'] }),
      rows: [
        { path: 'src/a.js', mi: 90 },
        { path: 'src/now-ignored.js', mi: 88 },
      ],
      existsOnDisk: () => true,
    });

    assert.deepEqual(found.extra, [
      { path: 'src/now-ignored.js', reason: EXTRA_REASONS.OUT_OF_SCOPE },
    ]);
  });

  test('a clean baseline reports neither direction', () => {
    const found = assertScope({
      inventory: inventoryOf({ files: ['src/a.js', 'src/b.js'] }),
      rows: [{ path: 'src/b.js' }, { path: 'src/a.js' }],
    });

    assert.deepEqual(found, {
      kind: 'maintainability',
      skipped: false,
      reason: null,
      missing: [],
      extra: [],
    });
  });

  test('rows with no usable key are ignored rather than crashing the gate', () => {
    const found = assertScope({
      inventory: inventoryOf({ files: ['src/a.js'] }),
      rows: [{ path: 'src/a.js' }, { path: '' }, {}, null],
    });

    assert.deepEqual(found.missing, []);
    assert.deepEqual(found.extra, []);
  });

  test('an unknown-scope inventory skips rather than declaring everything extra', () => {
    const found = assertScope({
      inventory: inventoryOf({
        files: null,
        degraded: true,
        reason: '.c8rc.cjs unreadable',
      }),
      rows: [{ path: 'src/a.js' }],
    });

    assert.equal(found.skipped, true);
    assert.equal(found.reason, '.c8rc.cjs unreadable');
    assert.deepEqual(found.extra, []);
  });
});

describe('assertScope — sparse producers never report phantom missing rows (AC-3)', () => {
  for (const kind of ['crap', 'duplication', 'lint', 'mutation']) {
    test(`${kind} asserts EXTRA only`, () => {
      assert.deepEqual([...directionsFor(kind)], ['extra']);

      const found = assertScope({
        inventory: inventoryOf({
          kind,
          files: ['src/a.js', 'src/no-row-and-that-is-fine.js'],
          directions: [...directionsFor(kind)],
        }),
        rows: [{ path: 'src/a.js' }, { path: 'src/gone.js' }],
      });

      // Sparse by construction: a file with no clone, no lint error, no
      // scorable method or no mutant legitimately has no row.
      assert.deepEqual(found.missing, []);
      // The EXTRA direction still works — sparse does not mean unassertable.
      assert.deepEqual(
        found.extra.map((row) => row.path),
        ['src/gone.js'],
      );
    });
  }

  for (const kind of ['lighthouse', 'bundle-size']) {
    test(`${kind} is excluded from both directions`, () => {
      assert.deepEqual([...directionsFor(kind)], []);
      assert.notEqual(KIND_SCOPE_POLICY[kind].keyField, 'path');

      const found = assertScope({
        inventory: inventoryOf({
          kind,
          keyField: KIND_SCOPE_POLICY[kind].keyField,
          files: ['src/a.js'],
          directions: [],
        }),
        rows: [{ route: '/pricing' }],
      });

      assert.equal(found.skipped, true);
      assert.deepEqual(found.missing, []);
      assert.deepEqual(found.extra, []);
    });
  }

  test('coverage and maintainability are the dense pair that assert both', () => {
    for (const kind of ['coverage', 'maintainability']) {
      assert.deepEqual([...directionsFor(kind)], ['missing', 'extra']);
    }
  });
});

describe('resolveStrictness — fail towards strict (AC-5)', () => {
  const attributable = {
    base: 'abc123',
    aheadOfBase: true,
    changedFiles: ['src/a.js'],
    baselinePaths: ['baselines/maintainability.json'],
    scopeConfigPaths: ['.c8rc.cjs', '.agentrc.json'],
  };

  test('a resolvable base ahead of HEAD attributes rather than blocking wholesale', () => {
    assert.deepEqual(resolveStrictness(attributable), {
      strict: false,
      reason: STRICT_REASONS.ATTRIBUTABLE,
    });
  });

  test('no resolvable base is strict', () => {
    assert.equal(
      resolveStrictness({ ...attributable, base: null }).reason,
      STRICT_REASONS.NO_BASE,
    );
    assert.equal(resolveStrictness({ ...attributable, base: '' }).strict, true);
  });

  test('a HEAD that is not ahead of its base is strict', () => {
    const resolved = resolveStrictness({ ...attributable, aheadOfBase: false });
    assert.equal(resolved.strict, true);
    assert.equal(resolved.reason, STRICT_REASONS.NOT_AHEAD);
  });

  test('a change set that edits a baseline is strict', () => {
    const resolved = resolveStrictness({
      ...attributable,
      changedFiles: ['src/a.js', 'baselines/maintainability.json'],
    });
    assert.equal(resolved.strict, true);
    assert.equal(resolved.reason, STRICT_REASONS.BASELINE_EDITED);
  });

  test('a change set that edits the config defining scope is strict', () => {
    // Once the branch has rewritten the scope rules, "which side of the
    // merge-base introduced this row" is not a question the diff can answer.
    const resolved = resolveStrictness({
      ...attributable,
      changedFiles: ['.c8rc.cjs'],
    });
    assert.equal(resolved.strict, true);
    assert.equal(resolved.reason, STRICT_REASONS.SCOPE_CONFIG_EDITED);
  });

  test('called with nothing at all, it is strict', () => {
    assert.equal(resolveStrictness().strict, true);
  });
});

describe('attributeDivergence — a PR is blocked only for what it created (AC-5)', () => {
  const missing = ['src/added-by-this-branch.js', 'src/inherited-hole.js'];
  const extra = [
    { path: 'src/deleted-by-this-branch.js', reason: EXTRA_REASONS.ABSENT },
    { path: 'src/inherited-stale.js', reason: EXTRA_REASONS.ABSENT },
  ];
  const changeSet = {
    added: ['src/added-by-this-branch.js'],
    removed: ['src/deleted-by-this-branch.js'],
  };

  test('a missing row for a file this change set added is fatal', () => {
    const split = attributeDivergence({ missing, extra, ...changeSet });

    assert.deepEqual(split.fatal.missing, ['src/added-by-this-branch.js']);
    assert.deepEqual(split.warning.missing, ['src/inherited-hole.js']);
  });

  test('a stale row for a file this change set deleted or renamed is fatal', () => {
    const split = attributeDivergence({ missing, extra, ...changeSet });

    assert.deepEqual(
      split.fatal.extra.map((row) => row.path),
      ['src/deleted-by-this-branch.js'],
    );
    assert.deepEqual(
      split.warning.extra.map((row) => row.path),
      ['src/inherited-stale.js'],
    );
    assert.equal(split.fatalCount, 2);
    assert.equal(split.warningCount, 2);
  });

  test('inherited divergence alone leaves nothing fatal', () => {
    const split = attributeDivergence({
      missing: ['src/inherited-hole.js'],
      extra: [{ path: 'src/inherited-stale.js', reason: EXTRA_REASONS.ABSENT }],
      added: [],
      removed: [],
    });

    assert.equal(split.fatalCount, 0);
    assert.equal(split.warningCount, 2);
  });

  test('strict promotes every finding, attributable or not', () => {
    const split = attributeDivergence({
      missing,
      extra,
      added: [],
      removed: [],
      strict: true,
    });

    assert.equal(split.fatalCount, 4);
    assert.equal(split.warningCount, 0);
  });

  test('a rename is fatal at both ends, because a rename strands a row', () => {
    // A rename reaches this function pre-decomposed: the old path in `removed`,
    // the new path in `added`. Both ends matter — the old row is now stale and
    // the new file is now unmeasured — and a report that caught only one would
    // leave the branch half-honest.
    const split = attributeDivergence({
      missing: ['src/new-name.js'],
      extra: [{ path: 'src/old-name.js', reason: EXTRA_REASONS.ABSENT }],
      added: ['src/new-name.js'],
      removed: ['src/old-name.js'],
    });

    assert.deepEqual(split.fatal.missing, ['src/new-name.js']);
    assert.deepEqual(
      split.fatal.extra.map((row) => row.path),
      ['src/old-name.js'],
    );
    assert.equal(split.warningCount, 0);
  });

  test('called with nothing at all, it reports nothing', () => {
    assert.deepEqual(attributeDivergence(), {
      fatal: { missing: [], extra: [] },
      warning: { missing: [], extra: [] },
      fatalCount: 0,
      warningCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// The CLI that carries the pure surface above. Spawned rather than imported:
// the exit code IS the contract a required CI check consumes, and `runAsCli`
// settles it through `process.exitCode` — which an in-process import cannot
// observe without also inheriting the module's side effects.
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(
  new URL('../../../scripts/check-baseline-scope.js', import.meta.url),
);
const TMP = fs.realpathSync(makeTempDir('scope-assert-cli-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let cliFixtureSeq = 0;

/**
 * A throwaway repo with one in-scope source file and a maintainability
 * baseline carrying whichever rows the case needs. No git history, so the
 * merge base never resolves and the run is strict — which is the point: the
 * fail-towards-strict path is the one a CI checkout without `fetch-depth: 0`
 * would take.
 *
 * @param {Array<{ path: string, mi: number }>} rows
 * @returns {string} Absolute fixture root.
 */
function cliFixture(rows) {
  cliFixtureSeq += 1;
  const root = path.join(TMP, `repo-${cliFixtureSeq}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/kept.js'), 'export const a = 1;\n');
  fs.writeFileSync(
    path.join(root, 'baselines/maintainability.json'),
    `${JSON.stringify(
      {
        $schema: '.agents/schemas/baselines/maintainability.schema.json',
        kernelVersion: currentKernelVersion('maintainability'),
        generatedAt: '2026-01-01T00:00:00.000Z',
        rollup: { '*': { min: 90, p50: 90, p95: 90 } },
        rows,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify(
      {
        project: {
          baseBranch: 'main',
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
          docsContextFiles: [],
          commands: { test: 'echo', typecheck: 'echo' },
        },
        github: { owner: 'x', repo: 'y', operatorHandle: '@ci' },
        delivery: {
          quality: {
            gates: {
              maintainability: {
                enabled: true,
                targetDirs: ['src'],
                floors: { '*': { min: 1 } },
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return root;
}

/**
 * Spawn the real CLI. Story #5111 keeps exactly two of these — the `--help`
 * contract (which must prove `runAsCli` fires the usage block *before* `main`,
 * a thing no in-process call can observe) and one smoke case that proves the
 * argv → `runScopeCheck` → stdout → exit-code wiring is connected at all.
 * Every other case drives the exported functions in-process: a `node`
 * cold start per assertion bought nothing the two spawns below do not already
 * prove, at ~274 ms each.
 *
 * @param {string[]} argv
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCliSpawn(argv) {
  const run = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf8',
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/**
 * The CLI's observable contract, in-process: the exit code a required CI check
 * consumes, and the stdout a human reads. Mirrors `main` in
 * `check-baseline-scope.js` — `--json` selects the report verbatim, anything
 * else the rendered text, and an argv or config error is EXIT_CANNOT_RUN with
 * a JSON `error` on stdout.
 *
 * @param {string[]} argv
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(argv) {
  try {
    const { report, exitCode } = runScopeCheck({ argv });
    return {
      status: exitCode,
      stdout: argv.includes('--json')
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatReport(report)}\n`,
      stderr: '',
    };
  } catch (err) {
    return {
      status: 2,
      stdout: `${JSON.stringify({ schemaVersion: '1', error: err?.message ?? String(err) }, null, 2)}\n`,
      stderr: '',
    };
  }
}

describe('check-baseline-scope CLI — exit codes are the contract', () => {
  test('--help exits 0 and runs no check at all', () => {
    // The gate must be describable on a checkout with no baselines and no
    // config; `runAsCli` fires the usage block before `main` for that reason.
    const run = runCliSpawn(['--help']);

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /check-baseline-scope/);
    assert.match(run.stdout, /prune-baseline-orphans/);
  });

  // The one real-spawn smoke case: proves argv reaches `runScopeCheck`, its
  // report reaches stdout, and its exit code reaches the shell — the wiring
  // the in-process cases below deliberately step over.
  test('a baseline that matches the tree exits 0 (real spawn)', () => {
    const run = runCliSpawn([
      '--cwd',
      cliFixture([{ path: 'src/kept.js', mi: 90 }]),
    ]);

    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /0 fatal/);
  });

  test('a stale row exits 1 and names both the row and the remedy', () => {
    const root = cliFixture([
      { path: 'src/kept.js', mi: 90 },
      { path: 'src/deleted.js', mi: 90 },
    ]);

    const run = runCli(['--cwd', root]);

    assert.equal(run.status, 1);
    assert.match(run.stdout, /stale row \(absent\): src\/deleted\.js/);
    assert.match(run.stdout, /prune-baseline-orphans\.js/);
  });

  test('an unmeasured in-scope file exits 1 and is NOT offered the pruner as a fix', () => {
    const run = runCli(['--cwd', cliFixture([]), '--json']);

    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout);
    const mi = report.kinds.find((entry) => entry.kind === 'maintainability');
    assert.deepEqual(mi.fatal.missing, ['src/kept.js']);
    assert.equal(report.strict, true);
    assert.equal(report.strictReason, STRICT_REASONS.NO_BASE);
  });

  test('--kind narrows the run, and an unknown kind is a config error', () => {
    const root = cliFixture([{ path: 'src/kept.js', mi: 90 }]);

    const narrowed = runCli([
      '--cwd',
      root,
      '--kind',
      'maintainability',
      '--json',
    ]);
    assert.equal(narrowed.status, 0, narrowed.stdout + narrowed.stderr);
    assert.deepEqual(
      JSON.parse(narrowed.stdout).kinds.map((entry) => entry.kind),
      ['maintainability'],
    );

    const bogus = runCli(['--cwd', root, '--kind', 'nonsense']);
    assert.equal(bogus.status, 2);
    assert.match(JSON.parse(bogus.stdout).error, /unknown --kind nonsense/);
  });

  test('an unknown flag is a config error, never a silent full-scope run', () => {
    const run = runCli(['--strictt']);

    assert.equal(run.status, 2);
    assert.match(JSON.parse(run.stdout).error, /unknown flag "--strictt"/);
  });
});

// ---------------------------------------------------------------------------
// Attribution end to end. The cases above all take the fail-towards-strict
// path, which never exercises the decomposition that makes attribution work:
// resolving a merge base, and reading `git diff --name-status -M` into the
// added / removed sets. A rename is the one change shape that lands in BOTH,
// and it is precisely the shape that strands a row — so it is proved here
// against real git rather than asserted about a hand-built change set.
// ---------------------------------------------------------------------------

/**
 * Env with every `GIT_*` variable dropped. Under a husky pre-push from a linked
 * worktree, git exports `GIT_DIR` pointing at the shared main gitdir, and a
 * fixture `git init` under that env writes into the MAIN checkout's config
 * (#4580).
 */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

/**
 * A fixture repo with real history: `origin/main` carries `src/kept.js`,
 * `src/old-name.js` and a maintainability baseline with a row for each, plus
 * whichever pre-existing stale row the case wants. HEAD then applies `mutate`
 * and commits it, WITHOUT touching the baseline — so the run stays in
 * attributed mode rather than falling through to strict.
 *
 * @param {{ rows: Array<{ path: string, mi: number }>, mutate: (root: string) => void }} spec
 * @returns {string} Absolute fixture root.
 */
function gitFixture({ rows, mutate }) {
  cliFixtureSeq += 1;
  const root = path.join(TMP, `git-repo-${cliFixtureSeq}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/kept.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src/old-name.js'), 'export const b = 2;\n');
  fs.writeFileSync(
    path.join(root, 'baselines/maintainability.json'),
    `${JSON.stringify(
      {
        $schema: '.agents/schemas/baselines/maintainability.schema.json',
        kernelVersion: currentKernelVersion('maintainability'),
        generatedAt: '2026-01-01T00:00:00.000Z',
        rollup: { '*': { min: 90, p50: 90, p95: 90 } },
        rows,
      },
      null,
      2,
    )}\n`,
  );
  fs.cpSync(
    path.join(cliFixture([]), '.agentrc.json'),
    path.join(root, '.agentrc.json'),
  );

  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: CLEAN_ENV,
    });

  git('init', '-q', '-b', 'main');
  seedGitIdentity(root);
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  mutate(root);
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return root;
}

describe('check-baseline-scope CLI — merge-base attribution end to end (AC-5)', () => {
  test('a rename this branch made is fatal at both ends', () => {
    const root = gitFixture({
      rows: [
        { path: 'src/kept.js', mi: 90 },
        { path: 'src/old-name.js', mi: 90 },
      ],
      mutate: (dir) =>
        fs.renameSync(
          path.join(dir, 'src/old-name.js'),
          path.join(dir, 'src/new-name.js'),
        ),
    });

    const run = runCli(['--cwd', root, '--json']);

    assert.equal(run.status, 1, run.stdout + run.stderr);
    const report = JSON.parse(run.stdout);
    // Attributed, not strict: the branch touched no baseline and no scope
    // config, so the merge base is trusted to explain the divergence.
    assert.equal(report.strict, false, JSON.stringify(report, null, 2));
    assert.equal(report.strictReason, STRICT_REASONS.ATTRIBUTABLE);

    const mi = report.kinds.find((entry) => entry.kind === 'maintainability');
    assert.deepEqual(mi.fatal.missing, ['src/new-name.js']);
    assert.deepEqual(
      mi.fatal.extra.map((row) => row.path),
      ['src/old-name.js'],
    );
    assert.equal(mi.warningCount, 0);
  });

  test('divergence this branch inherited is a warning, and the run still exits 0', () => {
    // The stale row predates the merge base and no in-scope file moved.
    // Blocking on it would red every open PR the moment anyone lands an
    // in-scope file, which is the failure attribution exists to prevent.
    const root = gitFixture({
      rows: [
        { path: 'src/kept.js', mi: 90 },
        { path: 'src/old-name.js', mi: 90 },
        { path: 'src/inherited-ghost.js', mi: 90 },
      ],
      mutate: (dir) =>
        fs.writeFileSync(path.join(dir, 'README.md'), '# unrelated\n'),
    });

    const run = runCli(['--cwd', root, '--json']);

    assert.equal(run.status, 0, run.stdout + run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.strict, false);
    const mi = report.kinds.find((entry) => entry.kind === 'maintainability');
    assert.deepEqual(mi.fatal.extra, []);
    assert.deepEqual(
      mi.warning.extra.map((row) => row.path),
      ['src/inherited-ghost.js'],
    );
  });

  test('--strict promotes that same inherited divergence to fatal', () => {
    const root = gitFixture({
      rows: [
        { path: 'src/kept.js', mi: 90 },
        { path: 'src/old-name.js', mi: 90 },
        { path: 'src/inherited-ghost.js', mi: 90 },
      ],
      mutate: (dir) =>
        fs.writeFileSync(path.join(dir, 'README.md'), '# unrelated\n'),
    });

    const run = runCli(['--cwd', root, '--strict']);

    assert.equal(run.status, 1);
    assert.match(run.stdout, /strict: operator requested --strict/);
    assert.match(run.stdout, /stale row \(absent\): src\/inherited-ghost\.js/);
  });

  test('editing a baseline fails the run towards strict', () => {
    const root = gitFixture({
      rows: [
        { path: 'src/kept.js', mi: 90 },
        { path: 'src/old-name.js', mi: 90 },
        { path: 'src/inherited-ghost.js', mi: 90 },
      ],
      mutate: (dir) => {
        // Any edit to the baseline: once the branch has rewritten the row set,
        // the diff can no longer say which side introduced a divergence.
        const file = path.join(dir, 'baselines/maintainability.json');
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        parsed.rows[0].mi = 91;
        fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
      },
    });

    const run = runCli(['--cwd', root, '--json']);

    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout);
    assert.equal(report.strict, true);
    assert.equal(report.strictReason, STRICT_REASONS.BASELINE_EDITED);
  });
});
