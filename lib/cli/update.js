// lib/cli/update.js
/**
 * `mandrel update` subcommand — the auto-update orchestrator (f-update-command,
 * Story #3503, Epic #3437 — Auto-Update & Version Lifecycle).
 *
 * Advances `@mandrel/agents` to the newest **non-major** published version,
 * re-materializes `.agents/`, runs applicable version-keyed migrations,
 * surfaces the target changelog, and verifies the result via the doctor
 * registry. A **major** crossing (e.g. `1.x → 2.0`) is gated: the orchestrator
 * refuses to apply it without `--major`, prints a pointer to
 * `docs/upgrade-major.md`, and exits non-zero without touching anything.
 *
 * ## Ordered cycle (happy path, non-major bump)
 *
 *   1. resolve target version (newest published) and the current version
 *   2. **major gate** — decline + non-zero exit when the target crosses a
 *      major boundary and `--major` is absent
 *   3. no-op short-circuit — already on the newest version ⇒ nothing to do
 *   4. npm update     — bump the dependency (lockfile bump left STAGED)
 *   5. runSync        — re-materialize ./.agents/ from the new payload
 *   6. runMigrations  — apply version-keyed steps for the crossed range
 *   7. doctor         — run the check registry; success ⇒ all checks pass
 *   8. surface the changelog for the target version
 *
 * ## No git mutation
 *
 * The npm dependency bump rewrites `package.json` / `package-lock.json` in the
 * working tree but the orchestrator performs **no** `git add` / `git commit`:
 * the lockfile bump is left staged-on-disk for the operator to review and
 * commit. This module never shells out to git.
 *
 * ## `--dry-run`
 *
 * Prints the resolved target version and the ordered step plan, then returns
 * without invoking any effectful seam (no npm update, no sync, no migrations,
 * no doctor) and writing nothing.
 *
 * ## Major gate
 *
 * The project sits on the **1.x** line under release-please
 * `always-bump-minor` ([AGENTS.md § Major-version policy]); a major release is
 * a deliberate manual operator decision, so adopting one must be equally
 * deliberate. When the newest version's major exceeds the current major:
 *   - **without `--major`**: print the available version + the
 *     `docs/upgrade-major.md` runbook pointer, exit non-zero, and invoke
 *     **no** npm-update / sync / migration / doctor seam.
 *   - **with `--major`**: apply the major target and print the runbook inline.
 * Routine minor/patch bumps within the 1.x line are never gated.
 *
 * ## Injectable seams (used by lib/cli/__tests__/update*.test.js)
 *
 *   - `argv`                — subcommand args (after `mandrel update`)
 *   - `currentVersion`      — the installed `@mandrel/agents` version string
 *   - `resolveTargetVersion`— async, returns the newest published version
 *   - `npmUpdate`           — async, performs the dependency bump (no git)
 *   - `runSync`             — re-materializes ./.agents/ (lib/cli/sync.js)
 *   - `runMigrations`       — version-keyed migration runner (lib/migrations)
 *   - `runDoctor`           — async, returns { ok, results } from the registry
 *   - `surfaceChangelog`    — emits the target changelog section
 *   - `write` / `writeErr`  — stdout / stderr sinks
 *   - `exit`                — process.exit replacement
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): logs only version
 * strings, step names, and the runbook path. No tokens, credentials, or env
 * values are read or logged; no shell-string interpolation occurs here (the
 * npm bump is delegated to the injected `npmUpdate` seam, which owns transport).
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigrations as defaultRunMigrations } from '../migrations/index.js';
import { registry } from './registry.js';
import { runSync as defaultRunSync } from './sync.js';

/** Path (relative to project root) of the major-upgrade runbook. */
const RUNBOOK_PATH = 'docs/upgrade-major.md';

/**
 * Parse a dotted semver-ish string into a numeric tuple. Non-numeric or
 * missing segments coerce to 0 so a partial version still compares sanely.
 *
 * @param {string} version
 * @returns {[number, number, number]}
 */
function parseVersion(version) {
  const [major, minor, patch] = String(version).split('.');
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

/**
 * Compare two version strings. Negative when `a < b`, zero when equal,
 * positive when `a > b` (the standard `Array.sort` comparator contract).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * True when `target`'s major axis is strictly greater than `current`'s — the
 * gated "crosses a major boundary" condition.
 *
 * @param {string} current
 * @param {string} target
 * @returns {boolean}
 */
function crossesMajor(current, target) {
  return parseVersion(target)[0] > parseVersion(current)[0];
}

/**
 * Resolve the installed `@mandrel/agents` version from this package's own
 * `package.json`. The module lives at `<root>/lib/cli/update.js`, so the
 * manifest is two directories up.
 *
 * @param {typeof nodeFs} [fs]
 * @returns {string}
 */
function defaultCurrentVersion(fs = nodeFs) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '..', '..', 'package.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return String(parsed.version);
}

/**
 * Default doctor seam: run every check in the registry sequentially and
 * report whether all passed. Mirrors lib/cli/doctor.js's pass accounting
 * without the formatted report (the orchestrator owns its own output).
 *
 * @param {{ checks?: typeof registry }} [opts]
 * @returns {Promise<{ ok: boolean, results: Array<{ name: string, ok: boolean }> }>}
 */
async function defaultRunDoctor({ checks = registry } = {}) {
  const results = [];
  for (const check of checks) {
    const r = await check.run();
    results.push({ name: check.name, ok: Boolean(r.ok) });
  }
  return { ok: results.every((r) => r.ok), results };
}

/**
 * The ordered step names the orchestrator drives on a non-major bump. Shared
 * by the live path and the `--dry-run` plan printout so the two never drift.
 */
const STEP_PLAN = ['npm-update', 'runSync', 'runMigrations', 'doctor'];

/**
 * Print the major-gate refusal: the available version, the runbook pointer,
 * and the re-run hint. No effectful seam runs after this.
 *
 * @param {string} target
 * @param {(s: string) => void} writeErr
 */
function emitMajorRefusal(target, writeErr) {
  writeErr(
    `mandrel update: a newer MAJOR version (${target}) is available; ` +
      'this is a breaking upgrade.\n' +
      `   → Review ${RUNBOOK_PATH}, then re-run with --major to apply it.\n`,
  );
}

/**
 * Run the `mandrel update` orchestration cycle.
 *
 * @param {{
 *   argv?: string[],
 *   currentVersion?: string | (() => string),
 *   resolveTargetVersion?: () => (string | Promise<string>),
 *   npmUpdate?: (version: string) => unknown | Promise<unknown>,
 *   runSync?: typeof defaultRunSync,
 *   runMigrations?: typeof defaultRunMigrations,
 *   runDoctor?: typeof defaultRunDoctor,
 *   surfaceChangelog?: (version: string) => unknown | Promise<unknown>,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   action: 'updated' | 'declined-major' | 'dry-run' | 'up-to-date' | 'doctor-failed',
 *   currentVersion: string,
 *   targetVersion: string | null,
 *   major: boolean,
 *   stepsRun: string[],
 *   dryRun: boolean,
 * }>}
 */
export async function runUpdate({
  argv = [],
  currentVersion,
  resolveTargetVersion,
  npmUpdate,
  runSync = defaultRunSync,
  runMigrations = defaultRunMigrations,
  runDoctor = defaultRunDoctor,
  surfaceChangelog,
  write = (s) => process.stdout.write(s),
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const allowMajor = argv.includes('--major');

  const current =
    typeof currentVersion === 'function'
      ? currentVersion()
      : (currentVersion ?? defaultCurrentVersion());

  if (typeof resolveTargetVersion !== 'function') {
    throw new Error(
      'mandrel update: resolveTargetVersion seam is required to determine the newest version',
    );
  }
  const target = String(await resolveTargetVersion());

  const major = crossesMajor(current, target);

  // --- Major gate -----------------------------------------------------------
  // A major crossing without --major is refused outright: no npm-update, no
  // sync, no migration, no doctor — print the runbook pointer and exit non-zero.
  if (major && !allowMajor) {
    emitMajorRefusal(target, writeErr);
    exit(1);
    return {
      ok: false,
      action: 'declined-major',
      currentVersion: current,
      targetVersion: target,
      major: true,
      stepsRun: [],
      dryRun,
    };
  }

  // --- No-op short-circuit --------------------------------------------------
  // Already on (or ahead of) the newest version: nothing to apply.
  if (compareVersions(target, current) <= 0) {
    write(`✅  Already up to date (v${current} is the newest version).\n`);
    return {
      ok: true,
      action: 'up-to-date',
      currentVersion: current,
      targetVersion: target,
      major,
      stepsRun: [],
      dryRun,
    };
  }

  // --- Dry run --------------------------------------------------------------
  // Print the resolved target and the ordered step plan; invoke no seam and
  // write nothing to disk.
  if (dryRun) {
    write(`mandrel update — planned upgrade v${current} → v${target}\n`);
    if (major) {
      write('  (major upgrade — --major supplied)\n');
    }
    STEP_PLAN.forEach((step, i) => {
      write(`  ${i + 1}. ${step}\n`);
    });
    write('  5. surface changelog\n');
    write('Dry run: no files written, no dependency bumped.\n');
    return {
      ok: true,
      action: 'dry-run',
      currentVersion: current,
      targetVersion: target,
      major,
      stepsRun: [],
      dryRun: true,
    };
  }

  // --- Major runbook (inline, when --major applies) -------------------------
  if (major) {
    write(
      `Applying MAJOR upgrade v${current} → v${target} (--major). ` +
        `Review the runbook: ${RUNBOOK_PATH}\n`,
    );
  } else {
    write(`Updating v${current} → v${target}…\n`);
  }

  const stepsRun = [];

  // 1. npm update — bump the dependency. The lockfile change is left STAGED
  //    on disk; this module never commits.
  if (typeof npmUpdate !== 'function') {
    throw new Error(
      'mandrel update: npmUpdate seam is required to bump the dependency',
    );
  }
  await npmUpdate(target);
  stepsRun.push('npm-update');

  // 2. runSync — re-materialize ./.agents/ from the freshly installed payload.
  runSync({ argv: [] });
  stepsRun.push('runSync');

  // 3. runMigrations — apply version-keyed steps for the crossed range.
  runMigrations({ fromVersion: current, toVersion: target, ctx: {} });
  stepsRun.push('runMigrations');

  // 4. doctor — verify the resulting install.
  const doctor = await runDoctor();
  stepsRun.push('doctor');

  // 5. surface the target changelog (best-effort; optional seam).
  if (typeof surfaceChangelog === 'function') {
    await surfaceChangelog(target);
  }

  if (!doctor.ok) {
    const failed = doctor.results.filter((r) => !r.ok).map((r) => r.name);
    writeErr(
      `mandrel update: upgraded to v${target} but doctor reported failures: ` +
        `${failed.join(', ')}\n` +
        '   → Run `mandrel doctor` for remedies.\n',
    );
    exit(1);
    return {
      ok: false,
      action: 'doctor-failed',
      currentVersion: current,
      targetVersion: target,
      major,
      stepsRun,
      dryRun: false,
    };
  }

  write(`✅  Updated to v${target}. The lockfile bump is staged for review.\n`);
  return {
    ok: true,
    action: 'updated',
    currentVersion: current,
    targetVersion: target,
    major,
    stepsRun,
    dryRun: false,
  };
}

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} argv - Subcommand arguments (after `mandrel update`).
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  await runUpdate({ argv });
}
