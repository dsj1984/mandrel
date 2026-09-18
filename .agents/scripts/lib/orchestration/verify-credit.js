/**
 * Report a full-suite `verify[]` entry as credited when the stamp or `test`
 * evidence close consults already covers it, instead of respawning the suite.
 * Read-only: an uncovered entry is `spawn: true`, so credit never
 * manufactures a pass.
 */

import { getQuality, resolveConfig } from '../config-resolver.js';
import { isCoverageFresh } from '../coverage-capture.js';
import { gitSpawn } from '../git-utils.js';
import { hasNpmScript, readPackageScripts } from '../npm-scripts.js';
import {
  hashCommandConfig,
  shouldSkip,
  treeFingerprint,
} from '../validation-evidence.js';

/** @type {string} */
export const FULL_SUITE_SHAPE_WARNING =
  'verify[] should be scoped entries plus the single credited full-suite run ' +
  '(deliver-digest.md § 5) — a full-suite command listed in verify[] is ' +
  'reported credited against that run, never respawned.';

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

const FULL_SUITE_SCRIPTS = new Set(['test', 'test:coverage']);

/** Filter flags that scope a bare-looking `node --test`; `=value` form too. */
const NARROWING_FLAGS = Object.freeze([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-only',
]);

/**
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
 * Strip a trailing `(<tier>)` tag, which would otherwise make every entry
 * look scoped.
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
 * Deliberately narrow: a false positive credits a scoped command without
 * running it. Any positional argument or narrowing flag means scoped.
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
  if (hasNarrowingFlag(tokens)) return false;

  if (tokens[0] === 'node') {
    const rest = tokens.slice(1);
    return rest.length > 0 && rest.every((t) => t.startsWith('-'));
  }

  if (!PACKAGE_MANAGERS.has(tokens[0])) return false;
  const rest = tokens[1] === 'run' ? tokens.slice(2) : tokens.slice(1);
  if (rest.length === 0 || !FULL_SUITE_SCRIPTS.has(rest[0])) return false;
  return rest.length === 1;
}

/**
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
 * @param {object} input
 * @param {string} input.command — tier tag already off.
 * @param {number|string} input.storyId
 * @param {string} input.worktree — ABSOLUTE path.
 * @param {string} [input.cwd] — evidence keyspace root; defaults to `worktree`.
 * @param {object} [deps] — test seams.
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
    treeFingerprintImpl = treeFingerprint,
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

  let stampReason = null;
  if (mode === 'capture') {
    const freshness = isCoverageFreshImpl({
      coveragePath: crap.coveragePath,
      targetDirs: crap.targetDirs,
      cwd: worktree,
    });
    if (freshness?.fresh === true) {
      return {
        ...scoped,
        mode,
        credited: true,
        spawn: false,
        reason: 'capture-stamp-fresh',
      };
    }
    stampReason = freshness?.reason ?? 'unknown';
  }

  // A stale stamp is not the last word: a green `npm test` deposits `test`
  // evidence, consulted in both modes before spawning.
  const verdict = readTestEvidence({
    storyId,
    worktree,
    cwd,
    gitSpawnFn,
    shouldSkipImpl,
    hashCommandConfigImpl,
    treeFingerprintImpl,
  });
  const credited = verdict.skip === true;
  return {
    ...scoped,
    mode,
    credited,
    spawn: !credited,
    reason: credited ? verdict.reason : (stampReason ?? verdict.reason),
  };
}

/**
 * An unreadable HEAD is `no-head`, never a credit.
 *
 * @param {{ storyId: number|string, worktree: string, cwd: string, gitSpawnFn: Function, shouldSkipImpl: Function, hashCommandConfigImpl: Function, treeFingerprintImpl: Function }} args
 * @returns {{ skip: boolean, reason: string }}
 */
function readTestEvidence({
  storyId,
  worktree,
  cwd,
  gitSpawnFn,
  shouldSkipImpl,
  hashCommandConfigImpl,
  treeFingerprintImpl,
}) {
  const headSha = readHeadSha(worktree, gitSpawnFn);
  if (!headSha) return { skip: false, reason: 'no-head' };
  return shouldSkipImpl(
    {
      storyId,
      gateName: 'test',
      currentSha: headSha,
      configHash: hashCommandConfigImpl({
        cmd: 'npm',
        args: ['test'],
        cwd: worktree,
      }),
      inputFingerprint: treeFingerprintImpl(worktree, gitSpawnFn),
    },
    { cwd, standalone: true },
  );
}

/**
 * @param {string[]} entries — raw lines, tier tags included.
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
