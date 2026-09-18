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
 * **Story #5364 — what "staged" means.** The probe read only the index, so a
 * manifest pair the operator staged *before* running the command still counted
 * as staged after the install rewrote both files on disk. Staged now means the
 * index differs from HEAD **and** the worktree agrees with the index, which the
 * in-memory fixture models by holding index *content* rather than a path set.
 * The final describe block drives `defaultGitStatus` against a **real**
 * throwaway git repository, because the porcelain column semantics the fix
 * turns on cannot be proven by a stub that merely re-states them.
 *
 * Tier: contract (testing-standards § Contract). The boundary under test is
 * the ordered contract between the update orchestrator and its downstream
 * phases (npm-update, then the sync / sync-commands / migrate / doctor spawn
 * phases) plus the staging report the cycle closes with.
 * The `runUpdate` cycles are driven entirely through its injectable surface —
 * no real npm process and no real network — with the git index modelled as a
 * faithful in-memory fake. Only the final `defaultGitStatus` block spawns real
 * `git`, against a temporary repository under the OS temp dir that it removes
 * again.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): the fixture
 * carries only version strings and file paths; no tokens, credentials, or
 * env values are constructed or logged.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  defaultDetectLockfile,
  defaultGitStatus,
  runUpdate,
} from '../../lib/cli/update.js';

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
 *   - `index`      — the content `git add` captured, per path.
 *
 * The index holds **content**, not just a path set, because "staged" is a
 * two-sided fact (Story #5364): the index must differ from HEAD *and* the
 * worktree must agree with the index. Modelling the index as a path set was
 * what let a pair staged before the install — and rewritten on disk by it —
 * read back as staged.
 *
 * The orchestrator's contract is that it bumps the manifest + lockfile and
 * never stages or commits them itself — whether the package manager staged
 * them is what the staging report reads back (Story #5339). This fixture lets
 * the tests assert every shape: a tree whose install staged the pair, one
 * whose install left everything unstaged, and one staged *before* the install
 * rewrote it.
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
  const index = new Map();
  const commits = [];

  /** Staged: the index differs from HEAD and the worktree agrees with it. */
  const isStaged = (path) =>
    index.has(path) &&
    index.get(path) !== committed.get(path) &&
    index.get(path) === workingTree.get(path);

  return {
    lockfile,
    tracksAgents,
    commits,
    isStaged,
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
      index.set(path, workingTree.get(path));
    },
    /**
     * What the read-only probe would report for this tree — the exact shape
     * `defaultGitStatus` returns.
     */
    gitState() {
      return {
        ok: true,
        stagedManifest: isStaged(PACKAGE_JSON),
        stagedLockfile: isStaged(lockfile),
        stagedPayload: isStaged(AGENTS_PATH),
        tracksAgents,
      };
    },
    /**
     * Record a commit of the staged paths. The orchestrator MUST NOT call
     * this — the test asserts `commits` stays empty.
     */
    commit(message) {
      const staged = [...index.keys()];
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
    gitStatus: gitStatus ?? (() => tree.gitState()),
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
        '.agents/ is tracked here, so stage the re-materialized payload too. ' +
        'Review and stage it: git add package.json pnpm-lock.yaml .agents/\n',
    );
    // The re-materialized payload really is dirty and unstaged in the fixture.
    assert.equal(tree.isStaged(AGENTS_PATH), false);
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
        stagedManifest: false,
        stagedLockfile: false,
        stagedPayload: false,
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
        stagedManifest: false,
        stagedLockfile: true,
        stagedPayload: false,
        tracksAgents: false,
      }),
    });

    assert.match(joined, /The dependency bump is NOT staged\./);
    assert.doesNotMatch(joined, /staged for review/);
  });

  // AC-1 — the regression Story #5364 was filed on. The operator staged the
  // manifest pair BEFORE running the command; the install then rewrote both
  // files on disk. Reading the index alone still called that "staged".
  it('reports a pair staged before the install — and rewritten by it — as NOT staged', async () => {
    const tree = makeWorkingTree();
    // The pre-run stage: both files differ from HEAD and are in the index.
    tree.write(PACKAGE_JSON, '{"version":"1.43.1-local"}');
    tree.write(LOCKFILE, '{"version":"1.43.1-local"}');
    tree.add(PACKAGE_JSON);
    tree.add(LOCKFILE);
    assert.equal(tree.isStaged(PACKAGE_JSON), true);

    // The install rewrites both on disk and stages neither (the pnpm shape).
    const { result, joined } = await driveGoldenPath(tree, {
      stageInstall: false,
    });

    assert.equal(
      joined,
      `Updating v${CURRENT_VERSION} → v${TARGET_VERSION}…\n` +
        `✅  Updated to v${TARGET_VERSION}. The dependency bump is NOT staged. ` +
        'Review and stage it: git add package.json package-lock.json\n',
    );
    assert.doesNotMatch(joined, /staged for review/);
    assert.equal(result.ok, true);
  });

  // AC-7 — a seam that throws is absorbed the same way a degraded probe is.
  it('degrades to the neutral line and exits 0 when a probe seam throws', async () => {
    const tree = makeWorkingTree();

    const { result, cap, joined } = await driveGoldenPath(tree, {
      stageInstall: false,
      gitStatus: () => {
        throw new Error('spawn git ENOENT');
      },
    });

    assert.match(
      joined,
      /Review the working tree and commit the bump \(git not available to report staging state\)\./,
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.equal(cap.exitCode, null);
  });
});

// ---------------------------------------------------------------------------
// Story #5364 — the drift-heal path reports too
// ---------------------------------------------------------------------------

/**
 * Drive the drift-heal branch: the installed version is already newest, but
 * `.agents/` is stale, so the cycle runs the two sync phases and nothing else.
 * No dependency is bumped, so the payload IS the whole diff.
 *
 * @param {{ gitStatus: Function, detectLockfile?: Function }} seams
 */
async function driveDriftHeal({ gitStatus, detectLockfile = () => LOCKFILE }) {
  const cap = makeCapture();
  const result = await runUpdate({
    argv: [],
    currentVersion: TARGET_VERSION,
    resolveTargetVersion: async () => TARGET_VERSION,
    checkDrift: () => true,
    cwd: () => '/fake/consumer',
    resolveBinScript: () =>
      '/fake/consumer/node_modules/mandrel/bin/mandrel.js',
    spawnPhase: async () => ({ ok: true, stdout: '', stderr: '' }),
    gitStatus,
    detectLockfile,
    write: cap.write,
    writeErr: cap.writeErr,
    exit: cap.exit,
  });
  return { result, cap, joined: cap.out.join('') };
}

describe('update drift heal — the re-materialized payload is reported', () => {
  // AC-4: the heal used to return with no staging line at all, so a consumer
  // that commits `.agents/` was told nothing about the diff it just produced.
  it('names the unstaged payload when the consumer tracks the materialized tree', async () => {
    const { result, joined } = await driveDriftHeal({
      gitStatus: () => ({
        ok: true,
        stagedManifest: false,
        stagedLockfile: false,
        stagedPayload: false,
        tracksAgents: true,
      }),
    });

    assert.equal(result.action, 'resynced');
    assert.match(
      joined,
      /The re-materialized \.agents\/ payload is NOT staged\. Review and stage it: git add \.agents\/\n$/,
    );
  });

  it('reports the payload as staged when the index carries it and the worktree is clean', async () => {
    const { joined } = await driveDriftHeal({
      gitStatus: () => ({
        ok: true,
        stagedManifest: false,
        stagedLockfile: false,
        stagedPayload: true,
        tracksAgents: true,
      }),
    });

    assert.match(
      joined,
      /The re-materialized \.agents\/ payload is staged for review\.\n$/,
    );
  });

  it('says nothing about staging when the consumer does not track .agents/', async () => {
    const { result, joined } = await driveDriftHeal({
      gitStatus: () => ({
        ok: true,
        stagedManifest: false,
        stagedLockfile: false,
        stagedPayload: false,
        tracksAgents: false,
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(
      joined.endsWith('The materialized payload is now current.\n'),
      true,
    );
    assert.doesNotMatch(joined, /staged/);
  });

  // AC-7, on the heal branch: a degraded probe never fails the heal.
  it('degrades to the neutral line and still reports success', async () => {
    const { result, cap, joined } = await driveDriftHeal({
      gitStatus: () => {
        throw new Error('spawn git ENOENT');
      },
    });

    assert.equal(result.ok, true);
    assert.equal(cap.exitCode, null);
    assert.match(joined, /git not available to report staging state/);
  });
});

// ---------------------------------------------------------------------------
// Story #5364 — the lockfile the consumer actually has
// ---------------------------------------------------------------------------

describe('update staging report — lockfile detection', () => {
  /** Minimal `existsSync`-only fs seam over an explicit path allowlist. */
  // `path.basename`, not a `/`-suffix match: `path.join` emits `\` separators
  // on Windows, where a hardcoded forward slash never matches and both cases
  // fail for a reason that has nothing to do with lockfile detection.
  const fakeFs = (present) => ({
    existsSync: (p) => present.includes(path.basename(String(p))),
  });

  // AC-3: `detectPackageManager` flattens bun → npm so the install-command
  // builder has a command to emit. The report must read the probe BEFORE that
  // flattening, or a bun consumer is told to stage a file it does not have.
  it('names bun.lockb on a bun consumer rather than the npm default', () => {
    assert.equal(
      defaultDetectLockfile('/fake/bun-consumer', fakeFs(['bun.lockb'])),
      'bun.lockb',
    );
  });

  it('still names each non-bun lockfile from the same probe', () => {
    assert.equal(
      defaultDetectLockfile('/fake/p', fakeFs(['pnpm-lock.yaml'])),
      'pnpm-lock.yaml',
    );
    assert.equal(
      defaultDetectLockfile('/fake/y', fakeFs(['yarn.lock'])),
      'yarn.lock',
    );
    assert.equal(
      defaultDetectLockfile('/fake/n', fakeFs(['package-lock.json'])),
      'package-lock.json',
    );
    // No recognizable toolchain still resolves to a concrete file.
    assert.equal(
      defaultDetectLockfile('/fake/empty', fakeFs([])),
      'package-lock.json',
    );
  });
});

// ---------------------------------------------------------------------------
// Story #5364 — the probe against a REAL git repository (AC-6)
// ---------------------------------------------------------------------------

/**
 * Build a throwaway git repository with a committed manifest pair and run the
 * callback against it. Exercising `defaultGitStatus` against real `git` output
 * is the point: the porcelain column semantics this Story turns on cannot be
 * proven by a stub that re-states them.
 *
 * @param {(repo: string, git: (...args: string[]) => void) => void} body
 */
function withGitRepo(body) {
  const repo = makeTempDir('mandrel-update-probe-');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  try {
    git('init', '-q', '.');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'package.json'), '{"v":0}');
    fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"v":0}');
    git('add', '-A');
    git('commit', '-qm', 'init');
    body(repo, git);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

describe('defaultGitStatus — the real git probe', () => {
  it('reports a pair staged with a clean worktree as staged (AC-2)', () => {
    withGitRepo((repo, git) => {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"v":1}');
      fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"v":1}');
      git('add', 'package.json', 'package-lock.json');

      const state = defaultGitStatus({
        cwd: repo,
        lockfile: 'package-lock.json',
      });

      assert.equal(state.ok, true);
      assert.equal(state.stagedManifest, true);
      assert.equal(state.stagedLockfile, true);
    });
  });

  it('reports a pair re-modified after staging as NOT staged (AC-1)', () => {
    withGitRepo((repo, git) => {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"v":1}');
      fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"v":1}');
      git('add', 'package.json', 'package-lock.json');
      // The install rewrites both files again — porcelain now reports `MM`.
      fs.writeFileSync(path.join(repo, 'package.json'), '{"v":2}');
      fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"v":2}');

      const state = defaultGitStatus({
        cwd: repo,
        lockfile: 'package-lock.json',
      });

      assert.equal(state.ok, true);
      assert.equal(state.stagedManifest, false);
      assert.equal(state.stagedLockfile, false);
    });
  });

  // AC-5: path matching is anchored at the probe root.
  it('does not let a nested workspace manifest satisfy the root check', () => {
    withGitRepo((repo, git) => {
      fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'packages', 'app', 'package.json'),
        '{"v":1}',
      );
      fs.writeFileSync(
        path.join(repo, 'packages', 'app', 'package-lock.json'),
        '{"v":1}',
      );
      git('add', 'packages');

      const state = defaultGitStatus({
        cwd: repo,
        lockfile: 'package-lock.json',
      });

      assert.equal(state.ok, true);
      assert.equal(state.stagedManifest, false);
      assert.equal(state.stagedLockfile, false);
    });
  });

  it('reports the tracked payload and its staged state', () => {
    withGitRepo((repo, git) => {
      fs.mkdirSync(path.join(repo, '.agents', 'rules'), { recursive: true });
      const payload = path.join(repo, '.agents', 'rules', 'x.md');
      fs.writeFileSync(payload, 'v0');
      git('add', '.agents');
      git('commit', '-qm', 'track payload');

      fs.writeFileSync(payload, 'v1');
      const dirty = defaultGitStatus({
        cwd: repo,
        lockfile: 'package-lock.json',
      });
      assert.equal(dirty.tracksAgents, true);
      assert.equal(dirty.stagedPayload, false);

      git('add', '.agents');
      const staged = defaultGitStatus({
        cwd: repo,
        lockfile: 'package-lock.json',
      });
      assert.equal(staged.stagedPayload, true);
    });
  });

  it('degrades to ok:false outside a repository, never throwing (AC-7)', () => {
    const outside = makeTempDir('mandrel-no-repo-');
    try {
      const state = defaultGitStatus({
        cwd: outside,
        lockfile: 'package-lock.json',
      });
      assert.equal(state.ok, false);
      assert.equal(state.stagedManifest, false);
      assert.equal(state.tracksAgents, false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // AC-8: the probe answers the whole contract from two reads.
  it('issues no more than two git invocations per run', () => {
    const invocations = [];
    const spy = (bin, args, opts) => {
      invocations.push([bin, ...args]);
      return spawnSync(bin, args, opts);
    };

    withGitRepo((repo) => {
      const state = defaultGitStatus({
        cwd: repo,
        lockfile: 'package-lock.json',
        spawnSync: spy,
      });
      assert.equal(state.ok, true);
    });

    assert.equal(invocations.length, 2, JSON.stringify(invocations));
    assert.ok(invocations.every(([bin]) => bin === 'git'));
  });
});
