/**
 * parse-args.js — Phase 1 of the check-baselines pipeline (Story #2466).
 *
 * Owns CLI flag parsing and the canned `--help` text. Migrated in Story
 * #2989 to delegate the bulk of argv walking to
 * `parseStandardCliArgs`; the wrapper preserves the legacy parsed shape
 * (storyId / epicId are now numbers, the rest of the keys are unchanged).
 *
 * `parseArgs(argv)` is re-exported from `check-baselines.js` and exercised
 * directly by the unit tests, so the function name and signature are
 * load-bearing.
 *
 * @module lib/orchestration/check-baselines/phases/parse-args
 */

import { parseStandardCliArgs } from '../../../cli/standard-args.js';

export const KNOWN_KINDS = Object.freeze([
  'lint',
  'coverage',
  'crap',
  'maintainability',
  'mutation',
  'lighthouse',
  'bundle-size',
  'duplication',
]);

export const DEFAULT_BASELINE_PATHS = Object.freeze({
  lint: 'baselines/lint.json',
  coverage: 'baselines/coverage.json',
  crap: 'baselines/crap.json',
  maintainability: 'baselines/maintainability.json',
  mutation: 'baselines/mutation.json',
  lighthouse: 'baselines/lighthouse.json',
  'bundle-size': 'baselines/bundle-size.json',
  duplication: 'baselines/duplication.json',
});

export const HELP_TEXT = `Usage: check-baselines.js [--config <path>] [--gate <kind>[,<kind>]] [--format json|text] [--no-friction] [--story <id>] [--epic <id>]

Unified baseline dispatcher. Per-kind pipeline (schema → floor → tolerance →
compare) over every configured gate, with centralised friction emission and
aggregated exit codes.

Exit codes:
  0  every enabled gate passes
  1  any floor breach
  2  any schema validation error
  3  config resolution error
  4  any head-vs-base regression
`;

export function helpReport() {
  return {
    schemaVersion: '1',
    help: true,
    knownKinds: [...KNOWN_KINDS],
  };
}

/**
 * Comma-split + repeat-aggregate the raw `--gate` tokens collected by
 * the shared parser. The original walker accepted both
 * `--gate coverage,lint` and `--gate coverage --gate lint` and
 * concatenated the values; we replicate that here in a single pass over
 * the `string-multi` array the shared parser produces.
 */
function flattenGateTokens(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts = [];
  for (const token of raw) {
    if (typeof token !== 'string') continue;
    for (const segment of token.split(',')) {
      const trimmed = segment.trim();
      if (trimmed.length > 0) parts.push(trimmed);
    }
  }
  return parts.length === 0 ? null : parts;
}

/**
 * Parse the CLI flags. Pure — exported for tests.
 *
 * Note: the migration to `parseStandardCliArgs` (Story #2989) changes
 * `storyId` / `epicId` from string to number — both `parseTicketId`
 * (positive integer, leading `#` stripped, `null` on invalid). The
 * downstream `emitFrictionSignal` short-circuits on falsy, and
 * `signals-writer` documents `storyId` / `epicId` as `number`, so the
 * type alignment fixes a latent string-vs-number mismatch.
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{
 *   configPath: string | null,
 *   gates: string[] | null,
 *   format: 'json' | 'text',
 *   friction: boolean,
 *   storyId: number | null,
 *   epicId: number | null,
 *   help?: boolean,
 * }}
 */
export function parseArgs(argv) {
  // `--help` / `-h` is a side-channel: the shared parser does not (yet)
  // surface a help flag; pre-scan and short-circuit before delegating.
  const helpRequested = argv.some((t) => t === '--help' || t === '-h');
  // Pre-validate `--format` so the legacy "expects json/text" message
  // shape survives. The shared parser would accept any string for an
  // extras `string` flag.
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--format') continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) continue;
    if (v !== 'json' && v !== 'text') {
      throw new Error(`--format expects "json" or "text"; got "${v}"`);
    }
  }

  let parsed;
  try {
    parsed = parseStandardCliArgs({
      argv: argv.filter((t) => t !== '--help' && t !== '-h'),
      extras: {
        config: { type: 'string', alias: 'configPath' },
        gate: { type: 'string-multi' },
        format: { type: 'string', default: 'json' },
        'no-friction': { type: 'boolean' },
      },
    });
  } catch (err) {
    if (err && err.code === 'UNKNOWN_FLAG') {
      // Preserve the legacy `unknown flag "--foo"` phrasing.
      throw new Error(`unknown flag "--${err.flag}"`);
    }
    throw err;
  }

  const { values } = parsed;
  const out = {
    configPath: values.configPath ?? null,
    gates: flattenGateTokens(values.gate),
    format: values.format ?? 'json',
    friction: !values.noFriction,
    storyId: values.storyId,
    epicId: values.epicId,
  };
  if (helpRequested) out.help = true;
  return out;
}
