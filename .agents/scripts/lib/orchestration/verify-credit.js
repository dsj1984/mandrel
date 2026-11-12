/**
 * Report a full-suite `verify[]` entry as credited when the stamp or `test`
 * evidence close consults already covers it, instead of respawning the suite.
 * Read-only: an uncovered entry is `spawn: true`, so credit never
 * manufactures a pass.
 */

import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';

import { resolveTestGateArgv } from '../close-validation/commands.js';
import { COVERAGE_CAPTURE_DEFAULTS } from '../config/gates/coverage.schema.js';
import { getQuality, resolveConfig } from '../config-resolver.js';
import { isCoverageFresh } from '../coverage-capture.js';
import {
  captureGates,
  isCaptureActive,
  primaryCaptureSource,
} from '../coverage-capture-passes.js';
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

const FULL_SUITE_SCRIPTS = new Set([
  'test',
  COVERAGE_CAPTURE_DEFAULTS.captureScript,
]);

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
 * The credit mode, and — in capture mode — the primary artifact's freshness.
 *
 * @param {{ quality: object, scripts: object, worktree: string, hasNpmScriptImpl: Function, isCoverageFreshImpl: Function }} opts
 */
function probeCaptureStamp({
  quality,
  scripts,
  worktree,
  hasNpmScriptImpl,
  isCoverageFreshImpl,
}) {
  const gates = captureGates(quality);
  if (!isCaptureActive({ ...gates, scripts, hasNpmScriptImpl })) {
    return { mode: 'evidence', freshness: null };
  }
  const freshness = isCoverageFreshImpl({
    coveragePath: primaryCaptureSource(gates).coveragePath,
    targetDirs: gates.crap.targetDirs,
    cwd: worktree,
  });
  return { mode: 'capture', freshness };
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
  const config = resolveConfigImpl({ cwd: worktree });
  const { mode, freshness } = probeCaptureStamp({
    quality: getQualityImpl(config),
    scripts: readPackageScriptsImpl(worktree),
    worktree,
    hasNpmScriptImpl,
    isCoverageFreshImpl,
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
  const stampReason =
    mode === 'capture' ? (freshness?.reason ?? 'unknown') : null;

  // A stale stamp is not the last word: a green `npm test` deposits `test`
  // evidence, consulted in both modes before spawning.
  const verdict = readTestEvidence({
    config,
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
 * The hashed argv is close's `test` gate argv (`project.commands.test`).
 *
 * @param {{ config: object|null, storyId: number|string, worktree: string, cwd: string, gitSpawnFn: Function, shouldSkipImpl: Function, hashCommandConfigImpl: Function, treeFingerprintImpl: Function }} args
 * @returns {{ skip: boolean, reason: string }}
 */
function readTestEvidence({
  config,
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
        ...resolveTestGateArgv(config),
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

const MANUAL_ENTRY = /^manual:/i;

export const VERIFY_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Any of these makes an entry compound, so its paths are not probed. */
const COMPOUND_SHELL = /[;|&<>()`]|\$\(/;

/** Flags whose next token is a value, not a test path. */
const VALUE_FLAGS = new Set([
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-concurrency',
  '--test-timeout',
  '--test-shard',
  '--test-isolation',
  '--test-global-setup',
  '--test-coverage-include',
  '--test-coverage-exclude',
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--conditions',
  '-C',
  '--config',
  '-c',
  '--project',
  '--reporter',
  '--root',
  '--dir',
  '-t',
  '--testNamePattern',
  '--environment',
  '--pool',
  '--shard',
  '--outputFile',
  '--exclude',
  '--maxWorkers',
  '--minWorkers',
  '--testTimeout',
  '--mode',
  '--workspace',
  '--retry',
]);

/** `parseVerifyEntry` plus collapsed whitespace: the evidence match key. */
export function normalizeVerifyCommand(entry) {
  return parseVerifyEntry(entry).command.replace(/\s+/g, ' ');
}

/** `required` must be evidenced; `scoped` (not full-suite) is also run. */
export function classifyVerifyEntries(entries) {
  const required = [
    ...new Set((entries ?? []).map(normalizeVerifyCommand).filter(Boolean)),
  ].filter((command) => !MANUAL_ENTRY.test(command));
  return {
    required,
    scoped: required.filter((command) => !isFullSuiteCommand(command)),
  };
}

const unquote = (token) => token.replace(/^(['"])(.*)\1$/, '$2');

/** Runner and test paths of a simple `vitest run` / `node --test`, else null. */
export function extractTestPaths(command) {
  if (COMPOUND_SHELL.test(command)) return null;
  const tokens = command.split(' ').map(unquote);
  let runner = 'node';
  let start = 2;
  if (tokens[0] !== 'node' || tokens[1] !== '--test') {
    const lead = { npx: 1, pnpm: 1, npm: tokens[1] === 'exec' ? 2 : -1 };
    const at = lead[tokens[0]] ?? 0;
    if (at < 0 || tokens[at] !== 'vitest' || tokens[at + 1] !== 'run') {
      return null;
    }
    runner = 'vitest';
    start = at + 2;
  }
  const paths = [];
  for (let i = start; i < tokens.length; i += 1) {
    if (!tokens[i].startsWith('-')) paths.push(tokens[i]);
    else if (VALUE_FLAGS.has(tokens[i])) i += 1;
  }
  return { runner, paths };
}

/** @param {string} pattern @param {string} cwd @returns {number} */
function countGlobFiles(pattern, cwd) {
  try {
    return globSync(pattern, { cwd }).length;
  } catch {
    return 0;
  }
}

/** Listed lines count: `vitest list` exits 0 on an empty selection. */
function countVitestFiles(testPath, cwd) {
  const res = spawnSync('npx', ['vitest', 'list', testPath, '--filesOnly'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: VERIFY_RUN_TIMEOUT_MS,
  });
  return String(res.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0).length;
}

/** Output goes to stderr so stdout stays one envelope; null on timeout. */
function spawnVerifyCommand(command, cwd) {
  const res = spawnSync(command, {
    cwd,
    shell: true,
    stdio: ['ignore', 2, 2],
    timeout: VERIFY_RUN_TIMEOUT_MS,
  });
  return Number.isInteger(res.status) ? res.status : null;
}

/** Run one scoped entry in `cwd`; a dead test path fails it unspawned. */
export function runScopedVerifyEntry(command, { cwd }, deps = {}) {
  const {
    spawnImpl = spawnVerifyCommand,
    listVitestImpl = countVitestFiles,
    globImpl = countGlobFiles,
  } = deps;
  const selection = extractTestPaths(command);
  const count = selection?.runner === 'vitest' ? listVitestImpl : globImpl;
  const deadPaths = (selection?.paths ?? []).filter((p) => count(p, cwd) < 1);
  const exitCode = deadPaths.length > 0 ? null : spawnImpl(command, cwd);
  return {
    command,
    exitCode,
    outcome: exitCode === 0 ? 'pass' : 'fail',
    deadPaths,
  };
}
