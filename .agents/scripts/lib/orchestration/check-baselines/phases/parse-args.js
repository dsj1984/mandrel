/**
 * parse-args.js — Phase 1 of the check-baselines pipeline (Story #2466).
 *
 * Owns CLI flag parsing and the canned `--help` text. Extracted verbatim
 * from `check-baselines.js` so the public CLI surface stays byte-identical.
 *
 * `parseArgs(argv)` is re-exported from `check-baselines.js` and exercised
 * directly by the unit tests, so the function name and signature are
 * load-bearing.
 *
 * @module lib/orchestration/check-baselines/phases/parse-args
 */

export const KNOWN_KINDS = Object.freeze([
  'lint',
  'coverage',
  'crap',
  'maintainability',
  'mutation',
  'lighthouse',
  'bundle-size',
]);

export const DEFAULT_BASELINE_PATHS = Object.freeze({
  lint: 'baselines/lint.json',
  coverage: 'baselines/coverage.json',
  crap: 'baselines/crap.json',
  maintainability: 'baselines/maintainability.json',
  mutation: 'baselines/mutation.json',
  lighthouse: 'baselines/lighthouse.json',
  'bundle-size': 'baselines/bundle-size.json',
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

function readStringFlag(out, key, argv, i) {
  if (!argv[i + 1]) return i;
  out[key] = argv[i + 1];
  return i + 1;
}

function readGateFlag(out, argv, i) {
  if (!argv[i + 1]) return i;
  const parts = argv[i + 1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  out.gates = (out.gates ?? []).concat(parts);
  return i + 1;
}

function readFormatFlag(out, argv, i) {
  if (!argv[i + 1]) return i;
  const v = argv[i + 1];
  if (v !== 'json' && v !== 'text') {
    throw new Error(`--format expects "json" or "text"; got "${v}"`);
  }
  out.format = v;
  return i + 1;
}

/**
 * Parse the CLI flags. Pure — exported for tests.
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{
 *   configPath: string | null,
 *   gates: string[] | null,
 *   format: 'json' | 'text',
 *   friction: boolean,
 *   storyId: string | null,
 *   epicId: string | null,
 *   help?: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    configPath: null,
    gates: null,
    format: 'json',
    friction: true,
    storyId: null,
    epicId: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') i = readStringFlag(out, 'configPath', argv, i);
    else if (a === '--gate') i = readGateFlag(out, argv, i);
    else if (a === '--format') i = readFormatFlag(out, argv, i);
    else if (a === '--no-friction') out.friction = false;
    else if (a === '--story') i = readStringFlag(out, 'storyId', argv, i);
    else if (a === '--epic') i = readStringFlag(out, 'epicId', argv, i);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (typeof a === 'string' && a.startsWith('--')) {
      throw new Error(`unknown flag "${a}"`);
    }
  }
  return out;
}
