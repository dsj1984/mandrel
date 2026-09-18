// lib/cli/migrate.js
/**
 * `mandrel migrate --from <v> --to <v> [--dry-run]`: run (or preview) the
 * version-keyed migrations outside an `update` cycle, e.g. to re-run one a
 * prior upgrade missed. Both bounds are required.
 */

import {
  migrations as defaultRegistry,
  runMigrations as defaultRunMigrations,
  selectStepsInRange,
} from '../migrations/index.js';

/**
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
 * @param {object} fields
 * @returns {object}
 */
function migrateResult(fields) {
  return {
    ok: false,
    action: 'usage-error',
    fromVersion: null,
    toVersion: null,
    dryRun: false,
    applied: [],
    skipped: [],
    wouldApply: [],
    wouldSkip: [],
    ...fields,
  };
}

/**
 * Both bounds are required: the runner filters `fromVersion < v <= toVersion`,
 * so an absent bound is ambiguous rather than a sensible default.
 *
 * @param {{ writeErr: (s: string) => void, exit: (code: number) => void }} io
 * @returns {void}
 */
function reportUsageError({ writeErr, exit }) {
  writeErr(
    'mandrel migrate: both --from <version> and --to <version> are required.\n' +
      '   → Usage: mandrel migrate --from <version> --to <version> [--dry-run]\n',
  );
  exit(1);
}

/**
 * Probes `detect` against a throwaway context and never calls `apply`. Uses
 * the live run's selector, so the preview cannot disagree with it.
 *
 * @param {{
 *   registry: Array<object>,
 *   fromVersion: string,
 *   toVersion: string,
 *   write: (s: string) => void,
 * }} params
 * @returns {{ wouldApply: string[], wouldSkip: string[] }}
 */
function previewMigrations({ registry, fromVersion, toVersion, write }) {
  const inRange = selectStepsInRange({ registry, fromVersion, toVersion });
  const wouldApply = [];
  const wouldSkip = [];
  const probeCtx = {};

  write(`mandrel migrate — dry run v${fromVersion} → v${toVersion}\n`);
  if (inRange.length === 0) {
    write('  (no migration steps in range)\n');
  }
  for (const step of inRange) {
    const bucket = step.detect(probeCtx) ? wouldApply : wouldSkip;
    const verb = bucket === wouldApply ? 'would apply ' : 'would skip  ';
    bucket.push(step.version);
    write(`  ${verb} ${step.version}: ${step.description}\n`);
  }
  write('Dry run: no migrations applied, nothing written.\n');

  return { wouldApply, wouldSkip };
}

/**
 * @param {{
 *   applied: string[],
 *   fromVersion: string,
 *   toVersion: string,
 *   write: (s: string) => void,
 * }} params
 * @returns {void}
 */
function reportApplied({ applied, fromVersion, toVersion, write }) {
  if (applied.length === 0) {
    write(
      `mandrel migrate: no migrations to apply for v${fromVersion} → v${toVersion}.\n`,
    );
    return;
  }
  const plural = applied.length === 1 ? '' : 's';
  write(
    `✅  Applied ${applied.length} migration${plural} (v${fromVersion} → v${toVersion}).\n`,
  );
}

/**
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

  if (!fromVersion || !toVersion) {
    reportUsageError({ writeErr, exit });
    return migrateResult({
      fromVersion: fromVersion ?? null,
      toVersion: toVersion ?? null,
      dryRun,
    });
  }

  if (dryRun) {
    const { wouldApply, wouldSkip } = previewMigrations({
      registry,
      fromVersion,
      toVersion,
      write,
    });
    return migrateResult({
      ok: true,
      action: 'dry-run',
      fromVersion,
      toVersion,
      dryRun: true,
      wouldApply,
      wouldSkip,
    });
  }

  const { applied, skipped } = runMigrations({
    fromVersion,
    toVersion,
    ctx,
    registry,
  });
  reportApplied({ applied, fromVersion, toVersion, write });

  return migrateResult({
    ok: true,
    action: 'migrated',
    fromVersion,
    toVersion,
    applied,
    skipped,
  });
}

/**
 * @param {string[]} argv - Subcommand arguments (after `mandrel migrate`).
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  runMigrate({ argv });
}
