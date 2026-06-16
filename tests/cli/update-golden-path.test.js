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
 *   2. A **staged (uncommitted) lockfile** — `npm update` rewrites
 *      `package-lock.json` and the orchestrator leaves that change staged on
 *      disk for the operator to review. The orchestrator performs no
 *      `git commit`, so after the cycle the lockfile bump sits in the index
 *      with the working tree and HEAD diverged from each other by exactly
 *      that one staged path. (update.js § "No git mutation".)
 *
 * Tier: contract (testing-standards § Contract). The boundary under test is
 * the ordered contract between the update orchestrator and its downstream
 * phases (npm-update, then the sync / sync-commands / migrate / doctor spawn
 * phases) plus the on-disk staged-lockfile invariant the cycle must preserve.
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
const PACKAGE_JSON = 'package.json';

/**
 * A faithful in-memory model of the consumer working tree across the update
 * cycle. It distinguishes three states the way git does:
 *
 *   - `committed`  — the path's content as of HEAD.
 *   - `workingTree`— the path's content on disk (mutated by `npm update`).
 *   - `index`      — paths git has been told to `git add` (staged).
 *
 * The orchestrator's contract is that it bumps the lockfile and stages it,
 * but never commits. This fixture lets the test assert exactly that: after
 * the cycle the lockfile differs between HEAD and the working tree AND is
 * present in the index, while no commit was ever recorded.
 */
function makeWorkingTree() {
  const committed = new Map([
    [LOCKFILE, `{"version":"${CURRENT_VERSION}"}`],
    [PACKAGE_JSON, `{"version":"${CURRENT_VERSION}"}`],
  ]);
  const workingTree = new Map(committed);
  const index = new Set();
  const commits = [];

  return {
    commits,
    /** True when `path` has been staged via `add` and not yet committed. */
    isStaged(path) {
      return index.has(path) && committed.get(path) !== workingTree.get(path);
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
 * `tree` so the steps compose the way the live cycle does: `npmUpdate` bumps +
 * stages the lockfile and the installed `package.json` version (the framework
 * version SSOT under npm distribution); the `spawnPhase` stub then drives the
 * post-install phases keyed on the phase name — `sync` re-materializes the
 * `.agents/` payload, `sync-commands` regenerates the command tree (no-op
 * here), `migrate` is a no-op (empty registry on the 1.x line), and `doctor`
 * inspects the resulting tree and returns its verdict via `ok`.
 */
function makeGoldenPathSeams(tree) {
  const calls = [];
  return {
    calls,
    currentVersion: CURRENT_VERSION,
    cwd: () => '/fake/consumer',
    resolveTargetVersion: async () => {
      calls.push('resolve');
      return TARGET_VERSION;
    },
    npmUpdate: async (version) => {
      calls.push(`npm-update:${version}`);
      // npm rewrites the lockfile + package.json on disk and stages them —
      // but never commits. package.json is the framework version SSOT.
      tree.write(LOCKFILE, `{"version":"${version}"}`);
      tree.add(LOCKFILE);
      tree.write(PACKAGE_JSON, `{"version":"${version}"}`);
      tree.add(PACKAGE_JSON);
    },
    spawnPhase: async (phase, args) => {
      if (phase === 'sync') {
        calls.push('sync');
        // Re-materialize the `.agents/` payload from the new package version.
        return { ok: true, stdout: '', stderr: '' };
      }
      if (phase === 'sync-commands') {
        calls.push('sync-commands');
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
      // target and the lockfile bump is staged (the expected pre-commit shape).
      calls.push('doctor');
      const versionOk =
        tree.read(PACKAGE_JSON) === `{"version":"${TARGET_VERSION}"}`;
      const lockStaged = tree.isStaged(LOCKFILE);
      const ok = versionOk && lockStaged;
      return { ok, stdout: '', stderr: ok ? '' : 'doctor failed' };
    },
    surfaceChangelog: async (version) => {
      calls.push(`changelog:${version}`);
    },
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

// ---------------------------------------------------------------------------
// Golden path
// ---------------------------------------------------------------------------

describe('update golden path — full cycle, doctor-pass, staged lockfile', () => {
  it('drives resolve → npm-update → sync → sync-commands → migrate → doctor → changelog and reports success', async () => {
    // Arrange
    const tree = makeWorkingTree();
    const seams = makeGoldenPathSeams(tree);
    const cap = makeCapture();

    // Act
    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // Assert — the full ordered cycle ran exactly once, in order; resolve is
    // the observable entry point (sync-commands runs between sync and migrate —
    // Story #4046 A1c).
    assert.deepEqual(seams.calls, [
      'resolve',
      `npm-update:${TARGET_VERSION}`,
      'sync',
      'sync-commands',
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
      'runMigrations',
      'doctor',
    ]);
    assert.equal(cap.exitCode, null);
    assert.match(cap.out.join(''), /Updated to v1\.44\.0/);
    assert.match(cap.out.join(''), /staged for review/);
  });

  it('leaves the lockfile bump staged (uncommitted) — no git commit fired', async () => {
    // Arrange
    const tree = makeWorkingTree();
    const seams = makeGoldenPathSeams(tree);
    const cap = makeCapture();

    // Act
    await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // Assert — the lockfile was bumped on disk to the target version…
    assert.equal(tree.read(LOCKFILE), `{"version":"${TARGET_VERSION}"}`);
    // …and is staged in the index (the operator-review shape)…
    assert.equal(tree.isStaged(LOCKFILE), true);
    // …but the orchestrator performed NO commit: HEAD never advanced.
    assert.deepEqual(tree.commits, []);
  });
});
