// tests/cli/update-golden-path.test.js
/**
 * Golden-path update-cycle test (roadmap Finding 17 — f-integration-docs-tests,
 * Story #3506, Epic #3437 — Auto-Update & Version Lifecycle).
 *
 * This is the **integration-flavored** counterpart to the per-branch unit
 * tests in `lib/cli/__tests__/update.test.js` / `update-version-resolution.test.js`. Those
 * files prove each branch of `runUpdate` in isolation; this file proves the
 * single end-to-end happy path that an operator actually walks: a minor-ahead
 * release drives the full ordered cycle
 *
 *     resolve → npm-update → sync → sync-commands → migrate → doctor
 *     → surfaceChangelog
 *
 * The post-install phases (sync, sync-commands, migrate, doctor) run through
 * the `spawnPhase` re-exec boundary — the sole post-install path since
 * Story #4182 retired the in-process runSync/runMigrations/runDoctor seam set
 * (No-Shim). The fixture's `spawnPhase` stub composes the same stateful
 * working-tree mutations keyed on the phase name.
 *
 * against one cohesive, **stateful** fixture and asserts two things the
 * unit tests do not:
 *
 *   1. The doctor-pass success path — doctor reads the post-sync /
 *      post-migration working-tree state the earlier steps produced, finds it
 *      healthy, and the run reports `action: 'updated'` with a zero exit.
 *   2. An **uncommitted lockfile** — the install rewrites the lockfile and the
 *      orchestrator leaves that change on disk for the operator to review. The
 *      orchestrator performs no `git add` and no `git commit`, so after the
 *      cycle the lockfile bump sits in the tree with HEAD unmoved.
 *      (update.js § "No git mutation".)
 *
 * **Story #5339 — the staging report.** The cycle used to close by *asserting*
 * "The lockfile bump is staged for review" whatever the index actually held.
 * That is a claim only `npm install` sometimes makes true; `pnpm add` /
 * `yarn add` stage nothing, so a pnpm consumer was told to review an empty
 * index. The orchestrator now *reports* the index through the read-only
 * `gitStatus` seam, and the second describe block below drives the golden path
 * under every state the seam can report — staged, unstaged (with and without a
 * tracked `.agents/` tree), and git unavailable — asserting each report line
 * verbatim.
 *
 * Tier: contract (testing-standards § Contract). The boundary under test is
 * the ordered contract between the update orchestrator and its downstream
 * phases (npm-update, then the sync / sync-commands / migrate / doctor spawn
 * phases) plus the staging report the cycle closes with.
 * All seams are driven through the injectable surface `runUpdate` exposes — no
 * real npm process, no real network, and no real `git` invocation occurs (the
 * git index is a faithful in-memory fake).
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): the fixture
 * carries only version strings and file paths; no tokens, credentials, or
 * env values are constructed or logged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runUpdate } from '../../lib/cli/update.js';

// ---------------------------------------------------------------------------
// Golden-path fixture
// ---------------------------------------------------------------------------

const CURRENT_VERSION = '1.43.0';
const TARGET_VERSION = '1.44.0';
const LOCKFILE = 'package-lock.json';
const PNPM_LOCKFILE = 'pnpm-lock.yaml';
const PACKAGE_JSON = 'package.json';
/** A representative path inside the re-materialized payload tree. */
const AGENTS_PATH = '.agents/rules/security-baseline.md';

/**
 * A faithful in-memory model of the consumer working tree across the update
 * cycle. It distinguishes three states the way git does:
 *
 *   - `committed`  — the path's content as of HEAD.
 *   - `workingTree`— the path's content on disk (mutated by the install).
 *   - `index`      — paths git has been told to `git add` (staged).
 *
 * The orchestrator's contract is that it bumps the manifest + lockfile and
 * never stages or commits them itself — whether the package manager staged
 * them is what the staging report reads back (Story #5339). This fixture lets
 * the tests assert both shapes: a tree whose install staged the pair, and one
 * whose install left everything unstaged.
 *
 * @param {{ lockfile?: string, tracksAgents?: boolean }} [opts]
 */
function makeWorkingTree({ lockfile = LOCKFILE, tracksAgents = false } = {}) {
  const committed = new Map([
    [lockfile, `{"version":"${CURRENT_VERSION}"}`],
    [PACKAGE_JSON, `{"version":"${CURRENT_VERSION}"}`],
  ]);
  if (tracksAgents) committed.set(AGENTS_PATH, `payload@${CURRENT_VERSION}`);
  const workingTree = new Map(committed);
  const index = new Set();
  const commits = [];

  const isDirty = (path) => committed.get(path) !== workingTree.get(path);

  return {
    lockfile,
    tracksAgents,
    commits,
    /** True when `path` has been staged via `add` and not yet committed. */
    isStaged(path) {
      return index.has(path) && isDirty(path);
    },
    /** Current on-disk content. */
    read(path) {
      return workingTree.get(path);
    },
    /** Write to the working tree (does not stage or commit). */
    write(path, content) {
      workingTree.set(path, content);
    },
    /** Stage a path (the only git mutation the cycle is allowed to make). */
    add(path) {
      index.add(path);
    },
    /** What `git diff --cached --name-only` would print for this tree. */
    stagedPaths() {
      return [...index].filter(isDirty);
    },
    /** What `git status --porcelain` would report as dirty-in-worktree. */
    unstagedPaths() {
      return [...workingTree.keys()].filter(
        (path) => isDirty(path) && !index.has(path),
      );
    },
    /**
     * Record a commit of the staged paths. The orchestrator MUST NOT call
     * this — the test asserts `commits` stays empty.
     */
    commit(message) {
      const staged = [...index];
      for (const path of staged) committed.set(path, workingTree.get(path));
      index.clear();
      commits.push({ message, paths: staged });
    },
  };
}

/**
 * Wire the full golden-path seam set against a shared working-tree fixture.
 * `npmUpdate` and the post-install `spawnPhase` boundary mutate / read the same
 * `tree` so the steps compose the way the live cycle does: `npmUpdate` bumps
 * the lockfile and the installed `package.json` version (the framework version
 * SSOT under npm distribution) — staging them only when the fixture's package
 * manager does (`stageInstall`, Story #5339); the `spawnPhase` stub then drives
 * the post-install phases keyed on the phase name — `sync` re-materializes the
 * `.agents/` payload, `sync-commands` regenerates the command tree (no-op
 * here); `sync-agents` regenerates the role-agent tree (no-op here, Story
 * #4528/#4530); `migrate` is a no-op (empty registry on the 1.x line); and
 * `doctor` inspects the resulting tree and returns its verdict via `ok`.
 *
 * The `gitStatus` / `detectLockfile` seams read the same fixture, so the
 * reported staging line is derived from the state the earlier phases produced
 * rather than hard-coded.
 *
 * @param {ReturnType<typeof makeWorkingTree>} tree
 * @param {{ stageInstall?: boolean, gitStatus?: Function }} [opts]
 */
function makeGoldenPathSeams(tree, { stageInstall = true, gitStatus } = {}) {
  const calls = [];
  return {
    calls,
    currentVersion: CURRENT_VERSION,
    cwd: () => '/fake/consumer',
    // Story #4613 — the re-exec resolves the bin *script* from the consumer
    // root; stub it so the fake cwd needs no real `mandrel` install on disk.
    resolveBinScript: () =>
      '/fake/consumer/node_modules/mandrel/bin/mandrel.js',
    resolveTargetVersion: async () => {
      calls.push('resolve');
      return TARGET_VERSION;
    },
    npmUpdate: async (version) => {
      calls.push(`npm-update:${version}`);
      // The install rewrites the lockfile + package.json on disk and never
      // commits. package.json is the framework version SSOT. Whether the
      // package manager also *stages* them is package-manager-specific: npm
      // may, pnpm/yarn do not — the fixture models both.
      tree.write(tree.lockfile, `{"version":"${version}"}`);
      tree.write(PACKAGE_JSON, `{"version":"${version}"}`);
      if (stageInstall) {
        tree.add(tree.lockfile);
        tree.add(PACKAGE_JSON);
      }
    },
    spawnPhase: async (phase, args) => {
      if (phase === 'sync') {
        calls.push('sync');
        // Re-materialize the `.agents/` payload from the new package version.
        // On a consumer that tracks the tree this is a real, unstaged diff —
        // the one the old success line invited operators to miss.
        if (tree.tracksAgents)
          tree.write(AGENTS_PATH, `payload@${TARGET_VERSION}`);
        return { ok: true, stdout: '', stderr: '' };
      }
      if (phase === 'sync-commands') {
        calls.push('sync-commands');
        return { ok: true, stdout: '', stderr: '' };
      }
      if (phase === 'sync-agents') {
        calls.push('sync-agents');
        return { ok: true, stdout: '', stderr: '' };
      }
      if (phase === 'migrate') {
        const from = args[args.indexOf('--from') + 1];
        const to = args[args.indexOf('--to') + 1];
        calls.push(`migrate:${from}->${to}`);
        // Empty registry on the 1.x line: nothing to apply.
        return { ok: true, stdout: '', stderr: '' };
      }
      // phase === 'doctor': read the post-sync state the earlier steps produced
      // and verify it is healthy — the bumped package.json version matches the
      // target and the lockfile carries it too. Doctor deliberately does NOT
      // require the pair to be staged: staging is the package manager's
      // business and the operator's decision, which is exactly why the CLI
      // reports the index rather than asserting it (Story #5339).
      calls.push('doctor');
      const versionOk =
        tree.read(PACKAGE_JSON) === `{"version":"${TARGET_VERSION}"}`;
      const lockBumped =
        tree.read(tree.lockfile) === `{"version":"${TARGET_VERSION}"}`;
      const ok = versionOk && lockBumped;
      return { ok, stdout: '', stderr: ok ? '' : 'doctor failed' };
    },
    surfaceChangelog: async (version) => {
      calls.push(`changelog:${version}`);
    },
    // Story #5339 — the read-only index probe. Defaults to a faithful read of
    // the fixture; a test passes its own stub to model "git unavailable".
    gitStatus:
      gitStatus ??
      (() => ({
        ok: true,
        staged: tree.stagedPaths(),
        unstaged: tree.unstagedPaths(),
        tracksAgents: tree.tracksAgents,
      })),
    detectLockfile: () => tree.lockfile,
  };
}

/** Capture stdout/stderr writes and the exit code. */
function makeCapture() {
  const out = [];
  const err = [];
  let exitCode = null;
  return {
    out,
    err,
    get exitCode() {
      return exitCode;
    },
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: (code) => {
      exitCode = code;
    },
  };
}

/**
 * Drive the golden path once and return the run result plus the capture.
 *
 * @param {ReturnType<typeof makeWorkingTree>} tree
 * @param {{ stageInstall?: boolean, gitStatus?: Function }} [opts]
 */
async function driveGoldenPath(tree, opts = {}) {
  const seams = makeGoldenPathSeams(tree, opts);
  const cap = makeCapture();
  const result = await runUpdate({
    argv: [],
    ...seams,
    write: cap.write,
    writeErr: cap.writeErr,
    exit: cap.exit,
  });
  return { result, cap, seams, joined: cap.out.join('') };
}

// ---------------------------------------------------------------------------
// Golden path
// ---------------------------------------------------------------------------

describe('update golden path — full cycle, doctor-pass, uncommitted lockfile', () => {
  it('drives resolve → npm-update → sync → sync-commands → sync-agents → migrate → doctor → changelog and reports success', async () => {
    // Arrange
    const tree = makeWorkingTree();

    // Act
    const { result, cap, seams, joined } = await driveGoldenPath(tree);

    // Assert — the full ordered cycle ran exactly once, in order; resolve is
    // the observable entry point (sync-commands runs between sync and
    // sync-agents — Story #4046 A1c; sync-agents runs between sync-commands
    // and migrate — Story #4528/#4530).
    assert.deepEqual(seams.calls, [
      'resolve',
      `npm-update:${TARGET_VERSION}`,
      'sync',
      'sync-commands',
      'sync-agents',
      `migrate:${CURRENT_VERSION}->${TARGET_VERSION}`,
      'doctor',
      `changelog:${TARGET_VERSION}`,
    ]);

    // Assert — doctor-pass success path.
    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.equal(result.targetVersion, TARGET_VERSION);
    assert.deepEqual(result.stepsRun, [
      'npm-update',
      'runSync',
      'sync-commands',
      'sync-agents',
      'runMigrations',
      'doctor',
    ]);
    assert.equal(cap.exitCode, null);
    assert.match(joined, /Updated to v1\.44\.0/);
  });

  it('leaves the lockfile bump uncommitted — no git commit fired', async () => {
    // Arrange
    const tree = makeWorkingTree();

    // Act
    await driveGoldenPath(tree);

    // Assert — the lockfile was bumped on disk to the target version…
    assert.equal(tree.read(LOCKFILE), `{"version":"${TARGET_VERSION}"}`);
    // …and this fixture's package manager staged it (the npm shape)…
    assert.equal(tree.isStaged(LOCKFILE), true);
    // …but the orchestrator performed NO commit: HEAD never advanced.
    assert.deepEqual(tree.commits, []);
  });
});

// ---------------------------------------------------------------------------
// Story #5339 — the staging report tells the truth about the index
// ---------------------------------------------------------------------------

describe('update golden path — staging report reflects the real index', () => {
  it('reports the bump as staged when the index actually carries the manifest and lockfile', async () => {
    const tree = makeWorkingTree();

    const { result, cap, joined } = await driveGoldenPath(tree, {
      stageInstall: true,
    });

    assert.equal(
      joined,
      `Updating v${CURRENT_VERSION} → v${TARGET_VERSION}…\n` +
        `✅  Updated to v${TARGET_VERSION}. The dependency bump is staged for review (package.json, package-lock.json).\n`,
    );
    assert.equal(result.ok, true);
    assert.equal(cap.exitCode, null);
  });

  it('reports the bump as NOT staged and prints the git add hint when nothing was staged', async () => {
    // The pnpm shape: `pnpm add -D` rewrites the manifest and lockfile and
    // stages neither. This fixture does not track `.agents/`, so the hint
    // names only the manifest pair.
    const tree = makeWorkingTree({ lockfile: PNPM_LOCKFILE });

    const { result, cap, joined } = await driveGoldenPath(tree, {
      stageInstall: false,
    });

    assert.equal(
      joined,
      `Updating v${CURRENT_VERSION} → v${TARGET_VERSION}…\n` +
        `✅  Updated to v${TARGET_VERSION}. The dependency bump is NOT staged. ` +
        'Review and stage it: git add package.json pnpm-lock.yaml\n',
    );
    assert.equal(tree.isStaged(PNPM_LOCKFILE), false);
    assert.equal(result.ok, true);
    assert.equal(cap.exitCode, null);
  });

  it('appends .agents/ to the git add hint when the consumer tracks the materialized tree', async () => {
    // The exact Beestera/swarm-os shape the Story was filed from: a pnpm
    // consumer that commits `.agents/`, so the sync's re-materialization is a
    // real unstaged diff the operator must not miss.
    const tree = makeWorkingTree({
      lockfile: PNPM_LOCKFILE,
      tracksAgents: true,
    });

    const { result, cap, joined } = await driveGoldenPath(tree, {
      stageInstall: false,
    });

    assert.equal(
      joined,
      `Updating v${CURRENT_VERSION} → v${TARGET_VERSION}…\n` +
        `✅  Updated to v${TARGET_VERSION}. The dependency bump is NOT staged. ` +
        'The sync re-materialized tracked .agents/ files — stage that diff too. ' +
        'Review and stage it: git add package.json pnpm-lock.yaml .agents/\n',
    );
    // The re-materialized payload really is dirty and unstaged in the fixture.
    assert.ok(tree.unstagedPaths().includes(AGENTS_PATH));
    assert.equal(result.ok, true);
    assert.equal(cap.exitCode, null);
  });

  it('degrades to a neutral line — still exiting 0 — when git cannot report', async () => {
    const tree = makeWorkingTree();

    const { result, cap, joined } = await driveGoldenPath(tree, {
      stageInstall: false,
      // git absent / not a repository / probe exited non-zero.
      gitStatus: () => ({
        ok: false,
        staged: [],
        unstaged: [],
        tracksAgents: false,
      }),
    });

    assert.equal(
      joined,
      `Updating v${CURRENT_VERSION} → v${TARGET_VERSION}…\n` +
        `✅  Updated to v${TARGET_VERSION}. Review the working tree and commit the bump ` +
        '(git not available to report staging state).\n',
    );
    // AC-2: the degraded probe never turns a successful update into a failure.
    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.equal(cap.exitCode, null);
    // …and no git mutation was attempted even on the degraded path.
    assert.deepEqual(tree.commits, []);
  });

  it('never claims a staged index when only one of the manifest / lockfile pair is staged', async () => {
    const tree = makeWorkingTree();

    const { joined } = await driveGoldenPath(tree, {
      stageInstall: false,
      gitStatus: () => ({
        ok: true,
        // Only the lockfile made it into the index — a half-staged bump is
        // not "staged for review".
        staged: [LOCKFILE],
        unstaged: [PACKAGE_JSON],
        tracksAgents: false,
      }),
    });

    assert.match(joined, /The dependency bump is NOT staged\./);
    assert.doesNotMatch(joined, /staged for review/);
  });
});
