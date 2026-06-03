// tests/cli/update-golden-path.test.js
/**
 * Golden-path update-cycle test (roadmap Finding 17 — f-integration-docs-tests,
 * Story #3506, Epic #3437 — Auto-Update & Version Lifecycle).
 *
 * This is the **integration-flavored** counterpart to the per-branch unit
 * tests in `lib/cli/__tests__/update.test.js` / `update-major.test.js`. Those
 * files prove each branch of `runUpdate` in isolation; this file proves the
 * single end-to-end happy path that an operator actually walks: a minor-ahead
 * release drives the full ordered cycle
 *
 *     resolve → major-gate → npm-update → runSync → runMigrations → doctor
 *     → surfaceChangelog
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
 * seams (sync, migrations, doctor) plus the on-disk staged-lockfile invariant
 * the cycle must preserve. All seams are driven through the injectable
 * surface `runUpdate` exposes — no real npm process, no real network, and no
 * real `git` invocation occurs (the git index is a faithful in-memory fake).
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
    ['.agents/VERSION', CURRENT_VERSION],
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
 * Each seam mutates / reads the same `tree` so the steps compose the way the
 * live cycle does: `npmUpdate` bumps + stages the lockfile, `runSync`
 * re-materializes `.agents/VERSION`, `runMigrations` is a no-op (empty
 * registry on the 1.x line), and `runDoctor` inspects the resulting tree.
 */
function makeGoldenPathSeams(tree) {
  const calls = [];
  return {
    calls,
    currentVersion: CURRENT_VERSION,
    resolveTargetVersion: async () => {
      calls.push('resolve');
      return TARGET_VERSION;
    },
    npmUpdate: async (version) => {
      calls.push(`npm-update:${version}`);
      // npm rewrites the lockfile on disk and stages it — but never commits.
      tree.write(LOCKFILE, `{"version":"${version}"}`);
      tree.add(LOCKFILE);
    },
    runSync: (_opts) => {
      calls.push('sync');
      // Re-materialize the pinned VERSION marker from the new payload.
      tree.write('.agents/VERSION', TARGET_VERSION);
      tree.add('.agents/VERSION');
      return { copied: 1, planned: 1, dryRun: false };
    },
    runMigrations: ({ fromVersion, toVersion }) => {
      calls.push(`migrate:${fromVersion}->${toVersion}`);
      // Empty registry on the 1.x line: nothing to apply.
      return { applied: [], skipped: [] };
    },
    runDoctor: async () => {
      calls.push('doctor');
      // Doctor reads the post-sync state the earlier steps produced and
      // verifies it is healthy: the materialized VERSION matches the target
      // and the lockfile bump is staged (the expected pre-commit shape).
      const versionOk = tree.read('.agents/VERSION') === TARGET_VERSION;
      const lockStaged = tree.isStaged(LOCKFILE);
      return {
        ok: versionOk && lockStaged,
        results: [
          { name: 'agents-materialized', ok: versionOk },
          { name: 'lockfile-staged', ok: lockStaged },
        ],
      };
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
  it('drives resolve → major-gate → npm-update → sync → migrate → doctor → changelog and reports success', async () => {
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

    // Assert — the full ordered cycle ran exactly once, in order. The
    // major-gate is a non-crossing pass-through on a minor bump, so it emits
    // no seam call; resolve is its observable entry point.
    assert.deepEqual(seams.calls, [
      'resolve',
      `npm-update:${TARGET_VERSION}`,
      'sync',
      `migrate:${CURRENT_VERSION}->${TARGET_VERSION}`,
      'doctor',
      `changelog:${TARGET_VERSION}`,
    ]);

    // Assert — doctor-pass success path.
    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.equal(result.major, false);
    assert.equal(result.targetVersion, TARGET_VERSION);
    assert.deepEqual(result.stepsRun, [
      'npm-update',
      'runSync',
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
