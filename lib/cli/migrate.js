// lib/cli/migrate.js
/**
 * `mandrel migrate` subcommand — the standalone migration runner entry
 * (f-migration-runner, Story #3505, Epic #3437 — Auto-Update & Version
 * Lifecycle).
 *
 * Exposes the version-keyed migration runner from `lib/migrations/index.js` as
 * a standalone command so operators can apply (or preview) on-disk migrations
 * without going through a full `mandrel update` cycle or a package bump. This
 * is the manual escape hatch for re-running a migration that a prior upgrade
 * missed, or for inspecting what a version crossing would do before committing
 * to it.
 *
 * ## CLI surface
 *
 *   mandrel migrate --from <v> --to <v> [--dry-run]
 *
 *   --from <v>   Version the tree is currently on (exclusive lower bound).
 *   --to   <v>   Version the tree is upgrading to (inclusive upper bound).
 *   --dry-run    Report the steps that WOULD run and write nothing.
 *
 * Both `--from` and `--to` are required for a live run; a missing bound is a
 * usage error (non-zero exit). `--from`/`--to` accept either `--from 1.4.0` or
 * `--from=1.4.0` spellings.
 *
 * ## `--dry-run`
 *
 * Resolves the in-range steps from the registry, consults each step's
 * `detect(ctx)` against a throwaway context to decide whether it would apply
 * or be skipped, prints the plan, and returns WITHOUT calling any step's
 * `apply` — nothing on disk changes. The dry-run never mutates the shared
 * context the caller would use for a live run; it probes a fresh `{}` so
 * `detect` side effects (there should be none) cannot leak into a later live
 * pass.
 *
 * ## Injectable seams (used by lib/cli/__tests__/migrate.test.js)
 *
 *   - `argv`           — subcommand args (after `mandrel migrate`)
 *   - `runMigrations`  — version-keyed migration runner (lib/migrations)
 *   - `registry`       — step registry; defaults to the module `migrations`
 *                        array, injected by tests with fixture steps so the
 *                        dry-run plan and the live pass are both exercisable
 *                        without a real contract step existing
 *   - `ctx`            — opaque context threaded to each step's detect/apply
 *   - `write`/`writeErr` — stdout / stderr sinks
 *   - `exit`           — process.exit replacement
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): logs only version
 * strings and step descriptions. No tokens, credentials, or env values are
 * read or logged, and no shell-string interpolation occurs (the runner is a
 * pure in-process call; transport is owned by the steps themselves).
 */

import {
  migrations as defaultRegistry,
  runMigrations as defaultRunMigrations,
} from '../migrations/index.js';

/**
 * Parse a single `--flag value` / `--flag=value` option out of argv.
 *
 * @param {string[]} argv
 * @param {string} flag  The long flag name including leading dashes (e.g. `--from`).
 * @returns {string | undefined} The option value, or undefined when absent.
 */
function parseOption(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) {
      return argv[i + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Parse a dotted semver-ish string into a numeric tuple. Mirrors the runner's
 * own comparator so the dry-run in-range filter matches the live filter
 * exactly.
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
 * Compare two version strings (standard `Array.sort` comparator contract).
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
 * Run the standalone `mandrel migrate` command.
 *
 * @param {{
 *   argv?: string[],
 *   runMigrations?: typeof defaultRunMigrations,
 *   registry?: typeof defaultRegistry,
 *   ctx?: unknown,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   action: 'migrated' | 'dry-run' | 'usage-error',
 *   fromVersion: string | null,
 *   toVersion: string | null,
 *   dryRun: boolean,
 *   applied: string[],
 *   skipped: string[],
 *   wouldApply: string[],
 *   wouldSkip: string[],
 * }}
 */
export function runMigrate({
  argv = [],
  runMigrations = defaultRunMigrations,
  registry = defaultRegistry,
  ctx = {},
  write = (s) => process.stdout.write(s),
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const fromVersion = parseOption(argv, '--from');
  const toVersion = parseOption(argv, '--to');

  // --- Usage validation -----------------------------------------------------
  // Both bounds are required: the runner filters fromVersion < v <= toVersion,
  // so an absent bound is ambiguous rather than a sensible default.
  if (!fromVersion || !toVersion) {
    writeErr(
      'mandrel migrate: both --from <version> and --to <version> are required.\n' +
        '   → Usage: mandrel migrate --from <version> --to <version> [--dry-run]\n',
    );
    exit(1);
    return {
      ok: false,
      action: 'usage-error',
      fromVersion: fromVersion ?? null,
      toVersion: toVersion ?? null,
      dryRun,
      applied: [],
      skipped: [],
      wouldApply: [],
      wouldSkip: [],
    };
  }

  // --- Dry run --------------------------------------------------------------
  // Report the in-range steps and whether each WOULD apply or be skipped,
  // probing a throwaway context so no step's apply runs and nothing on disk
  // changes.
  if (dryRun) {
    const inRange = registry
      .filter(
        (step) =>
          compareVersions(step.version, fromVersion) > 0 &&
          compareVersions(step.version, toVersion) <= 0,
      )
      .sort((a, b) => compareVersions(a.version, b.version));

    const wouldApply = [];
    const wouldSkip = [];
    const probeCtx = {};

    write(`mandrel migrate — dry run v${fromVersion} → v${toVersion}\n`);
    if (inRange.length === 0) {
      write('  (no migration steps in range)\n');
    }
    for (const step of inRange) {
      const willApply = step.detect(probeCtx);
      if (willApply) {
        wouldApply.push(step.version);
        write(`  would apply  ${step.version}: ${step.description}\n`);
      } else {
        wouldSkip.push(step.version);
        write(`  would skip   ${step.version}: ${step.description}\n`);
      }
    }
    write('Dry run: no migrations applied, nothing written.\n');

    return {
      ok: true,
      action: 'dry-run',
      fromVersion,
      toVersion,
      dryRun: true,
      applied: [],
      skipped: [],
      wouldApply,
      wouldSkip,
    };
  }

  // --- Live run -------------------------------------------------------------
  // Delegate to the runner, which owns ordering, range filtering, idempotency,
  // and the per-step `migrated …` log line.
  const { applied, skipped } = runMigrations({
    fromVersion,
    toVersion,
    ctx,
    registry,
  });

  if (applied.length === 0) {
    write(
      `mandrel migrate: no migrations to apply for v${fromVersion} → v${toVersion}.\n`,
    );
  } else {
    write(
      `✅  Applied ${applied.length} migration${
        applied.length === 1 ? '' : 's'
      } (v${fromVersion} → v${toVersion}).\n`,
    );
  }

  return {
    ok: true,
    action: 'migrated',
    fromVersion,
    toVersion,
    dryRun: false,
    applied,
    skipped,
    wouldApply: [],
    wouldSkip: [],
  };
}

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} argv - Subcommand arguments (after `mandrel migrate`).
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  runMigrate({ argv });
}
