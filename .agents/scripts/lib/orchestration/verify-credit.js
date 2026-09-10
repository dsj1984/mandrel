/**
 * verify-credit.js — decide whether a Story `verify[]` entry has already been
 * paid for by the delivery's single credited full-suite run (Story #5174).
 *
 * A Story's `verify[]` is meant to be *scoped* entries plus the one credited
 * full-suite run the worker makes just before the hand-off push
 * (`helpers/deliver-digest.md` § 5). When a `verify[]` entry is itself a
 * full-suite command, running it spends a second whole-suite spawn for a
 * result the credited run already established — and the close gate chain then
 * makes a third. This module is the read side of that credit: given the
 * entry's command it consults **the same stamp close consults** and reports
 * the entry as credited instead of telling the caller to spawn it.
 *
 * It only ever *reads*. Nothing here writes a capture stamp or an evidence
 * record — an entry that is not covered by a fresh stamp is reported
 * `spawn: true` and runs for real, so the credit can never manufacture a pass.
 *
 * @see .agents/scripts/lib/coverage-capture.js (`isCoverageFresh`)
 * @see .agents/scripts/lib/validation-evidence.js (`shouldSkip`)
 */

import { getQuality, resolveConfig } from '../config-resolver.js';
import { isCoverageFresh } from '../coverage-capture.js';
import { gitSpawn } from '../git-utils.js';
import { hasNpmScript, readPackageScripts } from '../npm-scripts.js';
import { hashCommandConfig, shouldSkip } from '../validation-evidence.js';

/**
 * The shape a `verify[]` array is supposed to have, stated once so the
 * warning a caller surfaces and the prose in `deliver-digest.md` § 5 say the
 * same thing.
 * @type {string}
 */
export const FULL_SUITE_SHAPE_WARNING =
  'verify[] should be scoped entries plus the single credited full-suite run ' +
  '(deliver-digest.md § 5) — a full-suite command listed in verify[] is ' +
  'reported credited against that run, never respawned.';

/** Package managers whose `test` script means "the whole suite". */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Script names that mean "the whole suite" rather than a scoped subset. */
const FULL_SUITE_SCRIPTS = new Set(['test', 'test:coverage']);

/**
 * Flags that narrow a runner's work to a subset of the suite (Story #5278).
 *
 * A positional path is not the only way to scope a run: Node's test runner
 * takes filter flags that select a fraction of the tests while the argv still
 * reads as a bare `node --test`. Crediting one of those against the full-suite
 * stamp reports a filtered run as the whole suite — the exact false positive
 * {@link isFullSuiteCommand} exists to refuse. Matched by prefix so both
 * spellings (`--test-only`, `--test-name-pattern=x`, `--test-name-pattern x`)
 * are caught.
 */
const NARROWING_FLAGS = Object.freeze([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-only',
]);

/**
 * Does any token narrow the run to a subset of the suite? Pure helper for
 * {@link isFullSuiteCommand}, split out so that function's own branching stays
 * inside its committed cyclomatic budget.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function hasNarrowingFlag(tokens) {
  return tokens.some((token) =>
    NARROWING_FLAGS.some(
      (flag) => token === flag || token.startsWith(`${flag}=`),
    ),
  );
}

/**
 * Split a Story `verify[]` line into its command and its tier tag.
 *
 * Story bodies write entries as `` `<command>` (<tier>) `` — the tier is
 * planning metadata, not part of the command, and leaving it attached would
 * make every entry look scoped.
 *
 * @param {string} entry
 * @returns {{ command: string, tier: string|null }}
 */
export function parseVerifyEntry(entry) {
  const text = String(entry ?? '').trim();
  const tagged = /^(.*?)\s*\(([a-z-]+)\)$/i.exec(text);
  const command = (tagged ? tagged[1] : text).trim().replace(/^`|`$/g, '');
  return { command: command.trim(), tier: tagged ? tagged[2] : null };
}

/**
 * Is this command a whole-suite run?
 *
 * Deliberately narrow. A false positive here would report a *scoped* command
 * as credited without ever running it, which is how a gate stops gating — so
 * anything carrying its own positional argument (`npm test -- tests/x.js`,
 * `node --test tests/x.js`) is scoped by construction.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isFullSuiteCommand(command) {
  const tokens = String(command ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  // A narrowing flag scopes the run wherever it appears — before the package
  // manager's `--` as much as after it — so the probe runs over the whole
  // token list rather than per-branch below.
  if (hasNarrowingFlag(tokens)) return false;

  if (tokens[0] === 'node') {
    // `node --test` with no path argument walks the default test globs.
    const rest = tokens.slice(1);
    return rest.length > 0 && rest.every((t) => t.startsWith('-'));
  }

  if (!PACKAGE_MANAGERS.has(tokens[0])) return false;
  const rest = tokens[1] === 'run' ? tokens.slice(2) : tokens.slice(1);
  if (rest.length === 0 || !FULL_SUITE_SCRIPTS.has(rest[0])) return false;
  // `npm test -- <path>` narrows the run; only a bare invocation is the suite.
  return rest.length === 1;
}

/**
 * Read HEAD from a worktree. `null` when the tree cannot be read — which
 * routes to `spawn`, never to a credit.
 *
 * @param {string} cwd
 * @param {Function} gitSpawnFn
 * @returns {string|null}
 */
function readHeadSha(cwd, gitSpawnFn) {
  const res = gitSpawnFn(cwd, 'rev-parse', 'HEAD');
  if (res?.status !== 0) return null;
  const sha = String(res.stdout ?? '').trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Decide how a single `verify[]` entry should be executed.
 *
 * @param {object} input
 * @param {string} input.command — the entry's command (tier tag already off).
 * @param {number|string} input.storyId
 * @param {string} input.worktree — ABSOLUTE path to the Story worktree.
 * @param {string} [input.cwd] — main checkout (evidence keyspace root).
 *   Defaults to `worktree`.
 * @param {object} [deps] — test seams; every one defaults to the real impl.
 * @returns {{
 *   command: string, fullSuite: boolean, credited: boolean, spawn: boolean,
 *   mode: 'capture'|'evidence'|null, reason: string, warning: string|null
 * }}
 */
export function resolveVerifyCredit(
  { command, storyId, worktree, cwd = worktree },
  deps = {},
) {
  const {
    resolveConfigImpl = resolveConfig,
    getQualityImpl = getQuality,
    readPackageScriptsImpl = readPackageScripts,
    hasNpmScriptImpl = hasNpmScript,
    isCoverageFreshImpl = isCoverageFresh,
    shouldSkipImpl = shouldSkip,
    hashCommandConfigImpl = hashCommandConfig,
    gitSpawnFn = gitSpawn,
  } = deps;

  const base = { command, fullSuite: false, mode: null, warning: null };
  if (!isFullSuiteCommand(command)) {
    return { ...base, credited: false, spawn: true, reason: 'scoped' };
  }

  const scoped = {
    ...base,
    fullSuite: true,
    warning: FULL_SUITE_SHAPE_WARNING,
  };
  const { crap } = getQualityImpl(resolveConfigImpl({ cwd: worktree }));
  const mode =
    crap?.enabled !== false &&
    hasNpmScriptImpl(readPackageScriptsImpl(worktree), 'test:coverage')
      ? 'capture'
      : 'evidence';

  if (mode === 'capture') {
    const freshness = isCoverageFreshImpl({
      coveragePath: crap.coveragePath,
      targetDirs: crap.targetDirs,
      cwd: worktree,
    });
    const fresh = freshness?.fresh === true;
    return {
      ...scoped,
      mode,
      credited: fresh,
      spawn: !fresh,
      reason: fresh ? 'capture-stamp-fresh' : (freshness?.reason ?? 'unknown'),
    };
  }

  const headSha = readHeadSha(worktree, gitSpawnFn);
  if (!headSha) {
    return { ...scoped, mode, credited: false, spawn: true, reason: 'no-head' };
  }
  const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
  const verdict = shouldSkipImpl(
    {
      storyId,
      gateName: 'test',
      currentSha: headSha,
      configHash: hashCommandConfigImpl({ cmd, args, cwd: worktree }),
    },
    { cwd, standalone: true },
  );
  return {
    ...scoped,
    mode,
    credited: verdict.skip === true,
    spawn: verdict.skip !== true,
    reason: verdict.reason,
  };
}

/**
 * Classify a whole `verify[]` array in one pass.
 *
 * @param {string[]} entries — raw `verify[]` lines, tier tags included.
 * @param {{ storyId: number|string, worktree: string, cwd?: string }} context
 * @param {object} [deps]
 * @returns {Array<ReturnType<typeof resolveVerifyCredit> & { tier: string|null }>}
 */
export function planVerifyExecution(entries, context, deps = {}) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const { command, tier } = parseVerifyEntry(entry);
    return { ...resolveVerifyCredit({ ...context, command }, deps), tier };
  });
}
