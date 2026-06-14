// tests/e2e/update-chain.integration.test.js
/**
 * End-to-end (real-binary) coverage of the `mandrel update` upgrade chain
 * (Story #4126, under Epic #4118 — test-health remediation).
 *
 * Unlike the seam-driven unit tests in `lib/cli/__tests__/update*.test.js`
 * (which inject fakes into `runUpdate`), this suite drives the **real** binary —
 * `node node_modules/mandrel/bin/mandrel.js update` — through its full
 * production chain against a real temp consumer:
 *
 *   resolve newest (`npm view`) → install the new version (real `npm install`) →
 *   re-exec `mandrel sync` / `sync-commands` / `migrate` / `doctor` from the
 *   **newly-installed** binary (the Story #4034 re-exec boundary) →
 *   surface the changelog.
 *
 * It is the only test that proves the `mandrel update` cycle end-to-end over a
 * genuine argv → dispatch → package-resolution → install → child-process
 * re-exec → disk round trip, asserting the headline contract: after an update,
 * **`.agents/` re-materializes** and **`mandrel doctor` reports ready**.
 *
 * ## Deterministic + offline (no live registry)
 *
 * Two boundaries in `mandrel update` would otherwise hit the network; both are
 * pinned to local sources so the test is hermetic:
 *
 *   1. The `npm view mandrel version` target probe is pointed at a **loopback
 *      registry** ({@link module:tests/e2e/helpers/local-registry}) that
 *      advertises a tarball THIS repo packed — so "newest" is a fixed, local
 *      value, never whatever is live on npmjs.com.
 *   2. The install step is driven via `--install-cmd "npm install --offline
 *      … <tarball>"`, so the dependency tree resolves from the local npm cache
 *      with zero network.
 *
 * ## Warm-cache precondition (graceful skip on a cold runner)
 *
 * That `--offline` install assumes the local npm cache is **warm** — on a dev
 * machine it is, from the repo's own install. A lockfile-less `--offline`
 * resolve needs the consumer deps' package-*metadata* (e.g.
 * `registry.npmjs.org/ajv`, to resolve `ajv@^8.20.0`), not just their tarballs.
 * A fresh CI runner's `npm ci --ignore-scripts` caches the lockfile-pinned
 * tarballs but NOT that metadata, so the resolve fails with `ENOTCACHED`. The
 * suite therefore **probes** the cache once at module load (see `setup()` /
 * COLD_CACHE_SKIP) and skips cleanly with a clear reason when it is cold,
 * instead of adding a costly/flaky online install. The update chain stays
 * covered on a cold runner by the activated `lib/cli/__tests__/update*.test.js`
 * unit suites and the Install Matrix workflow's real published-package install.
 *
 * The "current" (pre-update) version is seeded **below** the packed version by
 * rewriting the seeded `node_modules/mandrel/package.json`, so `update` has a
 * real upgrade to perform (current `X` → newest `Y`) rather than short-circuiting
 * on the up-to-date / drift-heal path.
 *
 * ## Why the `update` run is driven async (load-bearing)
 *
 * The loopback registry runs on **this test process's event loop**. `mandrel
 * update`'s first step shells `npm view`, which blocks on a registry response.
 * Driving the child with a synchronous `spawnSync` would freeze this event loop
 * for the whole run, so the in-process registry could never answer `npm view`
 * and the chain would deadlock. The update run therefore uses an **async**
 * `spawn` ({@link runBinary}) so the event loop keeps serving the registry.
 * (The seed `npm install` / `--version` probes stay synchronous — no in-process
 * server has to respond during them.)
 *
 * ## Hermetic doctor verdict
 *
 * `mandrel doctor`'s `github-token` / `gh-auth` checks consult the environment
 * (and `gh auth token`) for a token. To keep the ready verdict independent of
 * the running machine's GitHub-auth state, the child env carries a **dummy**
 * `GITHUB_TOKEN`/`GH_TOKEN`: `github-token` passes on the env token and `gh-auth`
 * degrades to warn-and-skip (the documented behaviour when a token is present
 * but `gh auth status` cannot validate it). This mirrors how the Install Matrix
 * workflow exports a token so doctor is honestly green. The `gh` CLI must be on
 * PATH (the `gh-available` check) — the same precondition the Install Matrix
 * gate already relies on.
 *
 * Tier: the `.integration.test.js` suffix auto-registers this file in the
 * per-PR integration tier (`INTEGRATION_INCLUDE` glob in test-tiers.js) — it is
 * a real `npm pack` + `npm install`, so it is slow by construction and belongs
 * out of the quick tier. Every temp dir and the loopback server are torn down
 * in `afterEach`/`after`.
 *
 * Security (security-baseline § Secrets Management / Transport): the only token
 * placed in any env is a non-secret literal dummy used solely to exercise the
 * doctor degrade path; the registry binds to 127.0.0.1; no real credentials or
 * network egress are involved.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { after, afterEach, describe, it } from 'node:test';

import { REPO_ROOT } from './helpers/cli-harness.js';
import { startLocalRegistry } from './helpers/local-registry.js';

/** Package name the registry + install advertise (matches `package.json`). */
const PACKAGE_NAME = 'mandrel';

/**
 * Hard ceiling for a single `mandrel update` run. Generous (real `npm install`
 * + four child-process re-exec phases) but bounded, so a regression that
 * deadlocks the chain fails the test fast instead of hanging CI.
 */
const UPDATE_TIMEOUT_MS = 180_000;

/** A payload file guaranteed to ship in the `.agents/` tree — proves materialization. */
const KNOWN_PAYLOAD_FILE = path.join('.agents', 'instructions.md');

/** The doctor "ready" verdict line (lib/cli/doctor.js). */
const DOCTOR_READY_RE = /✅\s+Ready \(\d+\/\d+ checks passed\)/;

/**
 * A non-secret literal token. Present only so doctor's `github-token` check
 * passes (env token) and `gh-auth` degrades to its documented warn-and-skip
 * path. Never a real credential.
 */
const DUMMY_TOKEN = 'mandrel-e2e-dummy-token';

/**
 * Cold-cache skip guard.
 *
 * This suite installs the consumer's dependency tree `--offline` (see
 * `seedConsumer` and the per-test `--install-cmd`). An `--offline` install with
 * no lockfile must resolve every dep from the **local npm cache**, which needs
 * not just the dep *tarballs* but the package-*metadata* documents (e.g.
 * `registry.npmjs.org/ajv`) to resolve a range like `ajv@^8.20.0`. On a dev
 * machine the cache is warm from the repo's own install, so this is hermetic
 * and fast; on a **fresh CI runner** `npm ci --ignore-scripts` caches the
 * lockfile-pinned tarballs but NOT those metadata documents, so the first
 * lockfile-less `--offline` resolve fails with `ENOTCACHED`
 * (`cache mode is 'only-if-cached' but no cached response is available`).
 *
 * Rather than add a network-dependent online install (per-PR cost + flakiness —
 * the test-health audit already flagged this e2e's cost), we **probe** the
 * cache once and skip the whole suite cleanly with a clear reason when it is
 * cold. The update chain stays covered elsewhere on a cold runner: the
 * activated `lib/cli/__tests__/update*.test.js` unit suites drive `runUpdate`
 * with injected fakes (no cache), and the Install Matrix workflow exercises a
 * real published-package install end to end. The probe + skip mirrors the
 * `node-pty`-availability guard in `init-interactive.integration.test.js`.
 *
 * Set at **module load** (in the top-level `setup()` below), NOT in a `before`
 * hook — `it(..., { skip })` snapshots its options when `describe` runs its
 * body, which is *before* any `before` hook fires, so a hook-set value would
 * always read stale `false`. The same load-time timing is why the PTY guard
 * runs at module scope. A string reason means "skip"; `false` means "cache is
 * warm, run normally".
 *
 * @type {string | false}
 */
let COLD_CACHE_SKIP = false;

/**
 * Decrement a semver to the nearest lower valid version, so the seeded
 * "current" install sits below the packed "newest" and `update` has work to do.
 *
 * @param {string} version - e.g. "1.64.0".
 * @returns {string} a strictly-lower semver, e.g. "1.63.0".
 */
function previousVersion(version) {
  const [maj, min, pat] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (pat > 0) return `${maj}.${min}.${pat - 1}`;
  if (min > 0) return `${maj}.${min - 1}.0`;
  return `${Math.max(0, maj - 1)}.0.0`;
}

/** Temp dirs created across the suite; removed in afterEach. */
const createdDirs = [];

/** Make a tracked temp dir (realpath'd for macOS /var symlink parity). */
function mkTempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  createdDirs.push(dir);
  return dir;
}

/**
 * Build a child env that is offline + hermetic:
 *   - `npm_config_registry` → the loopback registry (steers `npm view`).
 *   - `NODE_ENV=test` and no `NOTIFICATION_WEBHOOK_URL` (no stray POSTs).
 *   - dummy GitHub token (doctor verdict independent of machine auth state).
 *
 * @param {string} registryUrl
 * @returns {NodeJS.ProcessEnv}
 */
function updateEnv(registryUrl) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    npm_config_registry: registryUrl,
    GITHUB_TOKEN: DUMMY_TOKEN,
    GH_TOKEN: DUMMY_TOKEN,
  };
  delete env.NOTIFICATION_WEBHOOK_URL;
  return env;
}

/**
 * Run the binary **asynchronously** and resolve once it exits.
 *
 * This MUST be async (not `spawnSync`). The loopback registry runs on **this
 * test process's event loop**; `mandrel update`'s very first step shells
 * `npm view mandrel version`, which blocks on a response from that registry. A
 * synchronous `spawnSync(update)` would freeze this event loop for the whole
 * run — so the in-process registry could never answer the `npm view` request,
 * and `update` → `spawnSync(npm view)` would deadlock forever. Driving the
 * child asynchronously keeps the event loop pumping so the registry responds.
 *
 * A bounded timeout SIGKILLs a wedged child so a regression fails fast.
 *
 * @param {string} binPath - Absolute path to the consumer's `mandrel` binary.
 * @param {string[]} args - Subcommand + flags.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number }} opts
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runBinary(binPath, args, { cwd, env, timeoutMs = UPDATE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

/**
 * Pack this repo, derive the "current" tarball, and probe the npm cache — all
 * at **module load** so the results are available when `describe` snapshots the
 * `it(..., { skip })` options (see COLD_CACHE_SKIP). Returns the immutable
 * artifacts the suite consumes; sets the module-scoped COLD_CACHE_SKIP as a
 * side effect when the local cache is too cold to resolve consumer deps offline.
 *
 * @returns {{ newestTarball: string, currentTarball: string, newestVersion: string, manifest: object, currentVersion: string }}
 */
function setup() {
  // Pack THIS repo into a tarball — the artifact `npm publish` would ship and
  // the "newest" version `update` resolves to. `--ignore-scripts` skips the
  // `prepare` hook (the repo `.npmrc` also sets ignore-scripts=true); pack
  // honours package.json `files` so `.agents/`, `bin/`, `lib/` are included.
  // Capture stdout (the tarball filename) but DISCARD stderr — `npm pack`
  // streams the full ~855-line "Tarball Contents" notice to stderr.
  const packDir = mkTempDir('mandrel-e2e-pack-');
  const packed = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', packDir],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
    .trim()
    .split('\n')
    .pop()
    .trim();
  const newestTarball = path.join(packDir, packed);
  assert.ok(
    fs.existsSync(newestTarball),
    `npm pack did not produce a tarball at ${newestTarball}`,
  );

  // Read the manifest straight from the tarball so the loopback packument
  // mirrors the real published metadata, and learn the packed version.
  const extractDir = mkTempDir('mandrel-e2e-extract-');
  execFileSync('tar', ['-xzf', newestTarball, '-C', extractDir], {
    encoding: 'utf8',
  });
  const pkgRoot = path.join(extractDir, 'package');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
  );
  const newestVersion = String(manifest.version);
  const currentVersion = previousVersion(newestVersion);
  assert.notEqual(
    currentVersion,
    newestVersion,
    'seeded current version must differ from newest',
  );

  // Derive a genuine "current" tarball (one minor below) by rewriting the
  // extracted manifest's version and re-taring. Installing this gives the
  // consumer a real `currentVersion` payload — so the update's install of the
  // newest tarball is a genuine version change npm actually applies (a plain
  // re-install of the SAME version is a no-op npm skips, which would leave the
  // installed version unchanged and break the upgrade assertion).
  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    `${JSON.stringify({ ...manifest, version: currentVersion }, null, 2)}\n`,
  );
  const currentTarball = path.join(packDir, `mandrel-${currentVersion}.tgz`);
  execFileSync('tar', ['-czf', currentTarball, '-C', extractDir, 'package'], {
    encoding: 'utf8',
  });
  assert.ok(
    fs.existsSync(currentTarball),
    `failed to derive the current (${currentVersion}) tarball`,
  );

  // Cold-cache availability probe. Do a lightweight offline resolve of the
  // current tarball into a throwaway temp dir with `--dry-run` (no real
  // writes): if it exits non-zero the local npm cache lacks the consumer's dep
  // metadata (ENOTCACHED — a fresh CI runner), so set COLD_CACHE_SKIP and every
  // `it` skips with a clear reason. Where the cache is warm (a dev machine) it
  // stays `false` and the suite runs.
  const probeDir = mkTempDir('mandrel-e2e-cachecheck-');
  const probe = spawnSync(
    'npm',
    [
      'install',
      currentTarball,
      '--offline',
      '--dry-run',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: probeDir, encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    COLD_CACHE_SKIP =
      'npm cache cold for consumer deps (e.g. ajv metadata); update-chain ' +
      'e2e requires a warm cache — runs locally / where the cache is warm, ' +
      'skipped here';
  }

  return {
    newestTarball,
    currentTarball,
    newestVersion,
    manifest,
    currentVersion,
  };
}

// Run setup at module load (before `describe` snapshots the `it` skip options).
const {
  newestTarball,
  currentTarball,
  newestVersion,
  manifest,
  currentVersion,
} = setup();

describe('mandrel update — real-binary upgrade chain (e2e)', () => {
  /** @type {string[]} per-test consumer dirs, reaped in afterEach. */
  let consumerDirs = [];
  /** @type {Awaited<ReturnType<typeof startLocalRegistry>> | null} */
  let registry = null;

  afterEach(async () => {
    if (registry) {
      await registry.close();
      registry = null;
    }
    // Reap only the per-test consumer dirs; the shared pack/extract/probe dirs
    // created in `setup()` survive until the final `after`.
    for (const dir of consumerDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    consumerDirs = [];
  });

  after(() => {
    while (createdDirs.length > 0) {
      fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
    }
  });

  /**
   * Scaffold a temp consumer whose installed `mandrel` is genuinely at
   * `currentVersion` (installed from the derived current tarball), with NO
   * `.agents/` materialized yet — exactly the pre-upgrade state.
   *
   * @returns {{ dir: string, binPath: string }}
   */
  function seedConsumer() {
    const dir = mkTempDir('mandrel-e2e-update-');
    consumerDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        { name: 'update-e2e-consumer', version: '1.0.0', private: true },
        null,
        2,
      )}\n`,
    );

    // Install the genuine `currentVersion` tarball offline (deps come from the
    // warm npm cache), skipping lifecycle scripts so `.agents/` is NOT
    // materialized yet — the pre-upgrade state.
    const install = spawnSync(
      'npm',
      [
        'install',
        currentTarball,
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(
      install.status,
      0,
      `seed install failed (status ${String(install.status)}):\n${install.stderr}`,
    );

    const binPath = path.join(
      dir,
      'node_modules',
      PACKAGE_NAME,
      'bin',
      'mandrel.js',
    );
    // Pre-state invariants: no .agents/ yet, and the installed version really is
    // the "current" one (no manifest-rewrite hack — npm installed it for real).
    assert.ok(
      !fs.existsSync(path.join(dir, '.agents')),
      'consumer must start with no materialized .agents/',
    );
    const ver = spawnSync(process.execPath, [binPath, '--version'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(
      ver.stdout.trim(),
      currentVersion,
      'seeded binary must report the current version',
    );

    return { dir, binPath };
  }

  it('upgrades current → newest, re-materializes .agents/, and doctor reports ready', {
    skip: COLD_CACHE_SKIP,
  }, async () => {
    const { dir, binPath } = seedConsumer();

    registry = await startLocalRegistry({
      tarballPath: newestTarball,
      version: newestVersion,
      manifest,
    });

    // Drive the REAL update chain ASYNC (see runBinary — the in-process
    // registry must keep answering `npm view` while the child runs). The
    // install uses --install-cmd so it pulls the tarball offline; the
    // `npm view` target probe hits the loopback registry (newest = newestVersion).
    const installCmd = `npm install --offline --ignore-scripts --no-audit --no-fund ${newestTarball}`;
    const run = await runBinary(
      binPath,
      ['update', '--install-cmd', installCmd],
      { cwd: dir, env: updateEnv(registry.url) },
    );

    const detail = `\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`;

    // 0. The chain ran to completion (did not hit the bounded timeout).
    assert.ok(!run.timedOut, `mandrel update timed out${detail}`);

    // 1. The chain exited cleanly with the "updated" headline.
    assert.equal(run.status, 0, `mandrel update exited non-zero${detail}`);
    assert.match(
      run.stdout,
      new RegExp(`Updated to v${newestVersion.replace(/\./g, '\\.')}`),
      `expected the "Updated to v${newestVersion}" success line${detail}`,
    );

    // 2. The `npm view` probe actually hit the loopback registry (proves the
    //    real target-resolution boundary ran, not a short-circuit).
    assert.ok(
      registry.requests.some((u) => u.startsWith(`/${PACKAGE_NAME}`)),
      `the loopback registry should have served the mandrel packument${detail}`,
    );

    // 3. `.agents/` re-materialized from the newly-installed payload (the
    //    headline contract). Both a top-level and the known payload file land.
    assert.ok(
      fs.statSync(path.join(dir, KNOWN_PAYLOAD_FILE)).isFile(),
      `expected ${KNOWN_PAYLOAD_FILE} to be re-materialized after update${detail}`,
    );

    // 4. The installed version advanced to newest (the real install ran).
    const verAfter = spawnSync(process.execPath, [binPath, '--version'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(
      verAfter.stdout.trim(),
      newestVersion,
      `installed version should be ${newestVersion} after update${detail}`,
    );

    // 5. doctor reported ready — emitted by the re-exec'd doctor phase, which
    //    runs from the NEW binary (so agents-drift compares against the new
    //    payload). The dummy token keeps the verdict independent of machine auth.
    assert.match(
      run.stdout,
      DOCTOR_READY_RE,
      `expected a "✅ Ready" doctor verdict in update output${detail}`,
    );
  });

  it('is re-runnable: a second update on the now-current consumer is a no-op (already up to date)', {
    skip: COLD_CACHE_SKIP,
  }, async () => {
    // First update brings the consumer to newest.
    const { dir, binPath } = seedConsumer();
    registry = await startLocalRegistry({
      tarballPath: newestTarball,
      version: newestVersion,
      manifest,
    });
    const installCmd = `npm install --offline --ignore-scripts --no-audit --no-fund ${newestTarball}`;
    const first = await runBinary(
      binPath,
      ['update', '--install-cmd', installCmd],
      { cwd: dir, env: updateEnv(registry.url) },
    );
    assert.ok(!first.timedOut, `first update timed out:\n${first.stderr}`);
    assert.equal(
      first.status,
      0,
      `first update failed:\n${first.stdout}\n${first.stderr}`,
    );

    // Second update: current === newest AND .agents/ matches the payload, so the
    // drift-aware short-circuit reports "Already up to date" and performs no
    // install (idempotency — instructions.md § 3.4).
    const second = await runBinary(
      binPath,
      ['update', '--install-cmd', installCmd],
      { cwd: dir, env: updateEnv(registry.url) },
    );
    const detail = `\n--- stdout ---\n${second.stdout}\n--- stderr ---\n${second.stderr}`;
    assert.ok(!second.timedOut, `second update timed out${detail}`);
    assert.equal(second.status, 0, `second update exited non-zero${detail}`);
    assert.match(
      second.stdout,
      /Already up to date/,
      `second update should short-circuit as up-to-date${detail}`,
    );
    // The payload is still materialized after the no-op run.
    assert.ok(
      fs.existsSync(path.join(dir, KNOWN_PAYLOAD_FILE)),
      `${KNOWN_PAYLOAD_FILE} must remain materialized after a no-op update${detail}`,
    );
  });
});
