/**
 * check-baselines CLI flag parsing and `--help` text.
 *
 * @module lib/orchestration/check-baselines/phases/parse-args
 */

import { parseStandardCliArgs } from '../../../cli/standard-args.js';

export const KNOWN_KINDS = Object.freeze([
  'coverage',
  'crap',
  'maintainability',
  'mutation',
  'bundle-size',
  'duplication',
]);

export const DEFAULT_BASELINE_PATHS = Object.freeze({
  coverage: 'baselines/coverage.json',
  crap: 'baselines/crap.json',
  maintainability: 'baselines/maintainability.json',
  mutation: 'baselines/mutation.json',
  'bundle-size': 'baselines/bundle-size.json',
  duplication: 'baselines/duplication.json',
});

export const HELP_TEXT = `Usage: check-baselines.js [--config <path>] [--gate <kind>[,<kind>]] [--format json|text] [--no-friction] [--story <id>] [--epic <id>]

Unified baseline dispatcher. Per-kind pipeline (schema → floor → tolerance →
compare) over every configured gate, with centralised friction emission and
aggregated exit codes.

Env vars:
  <KIND>_REFRESH=1       One-shot acknowledge for a deliberate baseline
                         refresh of that kind: demotes its head-vs-base
                         regressions to "unchanged" for this run only. Floors
                         are STILL enforced, so a genuine breach is still
                         caught. The kind name is upper-snaked, e.g.
                         COVERAGE_REFRESH, CRAP_REFRESH, DUPLICATION_REFRESH,
                         MAINTAINABILITY_REFRESH, BUNDLE_SIZE_REFRESH.
                         Never persisted — the next run without the flag
                         re-enforces the ratchet at full strength.

                         Equivalent commit-tagged trigger: a commit in the
                         compared range whose subject contains
                         'baseline-refresh:' AND whose
                         diff touches that kind's baseline file. One-shot by
                         construction — once merged the refreshed baseline is
                         the new base and the tag leaves the range.

                         Use these when replacing a diff-scope baseline with a
                         full-scope measurement: the resulting row deltas are
                         arithmetic, not behavioural.

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

/** Accept both `--gate a,b` and repeated `--gate a --gate b`. */
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
  // The shared parser has no help flag and accepts any `--format` string.
  const helpRequested = argv.some((t) => t === '--help' || t === '-h');
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
