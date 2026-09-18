/**
 * Single source of truth for every path under `project.paths.tempRoot`:
 * `run-<eid>/…` and `run-<eid>/stories/story-<sid>/…`, with standalone
 * Stories under `standalone/stories/story-<sid>/`.
 *
 * A relative tempRoot is anchored to the main checkout root (parent of
 * `git rev-parse --git-common-dir`), not cwd, so a writer inside a Story
 * worktree and the host reading from the main checkout converge on one file.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reapOnExit } from '../test-temp.js';

/** Keyed by cwd; a cached `null` records a non-repo miss. */
const _mainCheckoutRootCache = new Map();

/**
 * Parent of `--git-common-dir`, which is the main checkout root from both the
 * main checkout and any linked worktree. `null` outside a repo.
 *
 * @param {string} [cwd=process.cwd()]
 * @param {{ exec?: typeof execFileSync }} [deps]
 * @returns {string|null}
 */
export function mainCheckoutRoot(cwd = process.cwd(), deps = {}) {
  const exec = deps.exec ?? execFileSync;
  // Only the real resolver is memoized.
  const memoize = !deps.exec;
  if (memoize && _mainCheckoutRootCache.has(cwd)) {
    return _mainCheckoutRootCache.get(cwd);
  }
  let resolved = null;
  try {
    const out = exec('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const commonDir = path.isAbsolute(out) ? out : path.resolve(cwd, out);
      resolved = path.dirname(commonDir);
    }
  } catch {
    resolved = null;
  }
  if (memoize) _mainCheckoutRootCache.set(cwd, resolved);
  return resolved;
}

/** Test-only. */
export function _clearMainCheckoutRootCache() {
  _mainCheckoutRootCache.clear();
}

/**
 * Absolute scratch tempRoot the test bootstrap arms, so any writer reaching a
 * relative root under test lands in scratch, not the repo's `temp/`.
 */
export const TEST_TEMP_ROOT_ENV = 'MANDREL_TEST_TEMP_ROOT';

/**
 * Only an absolute override is honoured; a relative one would re-anchor
 * into the repo and defeat the isolation.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
function testScratchTempRoot(env = process.env) {
  const override = env?.[TEST_TEMP_ROOT_ENV];
  return typeof override === 'string' &&
    override.length > 0 &&
    path.isAbsolute(override)
    ? override
    : null;
}

/** `'1'` opts a test-context process back into the real `temp/` tree. */
export const TEST_ALLOW_REAL_TEMP_ENV = 'MANDREL_TEST_ALLOW_REAL_TEMP';

let _testContextScratchDir = null;

/** Test-only. */
export function _clearTestContextScratchCache() {
  _testContextScratchDir = null;
}

/**
 * `NODE_TEST_CONTEXT` (set on every node:test child) or a `--test` execArgv.
 * The single shared detector — the live-filing guard uses it too.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {string[]} [execArgv=process.execArgv]
 * @returns {boolean}
 */
export function inNodeTestContext(
  env = process.env,
  execArgv = process.execArgv,
) {
  return (
    Boolean(env?.NODE_TEST_CONTEXT) ||
    (Array.isArray(execArgv) && execArgv.includes('--test'))
  );
}

/**
 * Absolute roots pass verbatim. A relative root joins, in order: the armed
 * scratch override; a lazily-created per-process scratch dir when this is a
 * node:test context (published to children via the env) unless
 * `TEST_ALLOW_REAL_TEMP_ENV=1`; the main checkout root; else stays relative.
 *
 * @param {string} tempRoot
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {{ mkdtemp?: typeof mkdtempSync, execArgv?: string[], onExit?: (fn: () => void) => void }} [deps]
 * @returns {string}
 */
export function anchorTempRoot(tempRoot, env = process.env, deps = {}) {
  if (path.isAbsolute(tempRoot)) return tempRoot;
  const scratch = testScratchTempRoot(env);
  if (scratch) return path.join(scratch, tempRoot);
  const execArgv = deps.execArgv ?? process.execArgv;
  if (
    inNodeTestContext(env, execArgv) &&
    env?.[TEST_ALLOW_REAL_TEMP_ENV] !== '1'
  ) {
    if (_testContextScratchDir === null) {
      const mkdtemp = deps.mkdtemp ?? mkdtempSync;
      // test-temp-allow: published to children below, so it must live
      // outside the per-process suite root that this process reaps.
      _testContextScratchDir = mkdtemp(
        path.join(os.tmpdir(), 'mandrel-test-temp-'),
      );
      // Creator-only reaping: a process that inherited the root returned at
      // `scratch` above, so it never removes a root its parent still uses.
      reapOnExit(
        _testContextScratchDir,
        deps.onExit ? { onExit: deps.onExit } : {},
      );
      if (env === process.env) {
        process.env[TEST_TEMP_ROOT_ENV] = _testContextScratchDir;
      }
    }
    return path.join(_testContextScratchDir, tempRoot);
  }
  const root = mainCheckoutRoot();
  return root ? path.join(root, tempRoot) : tempRoot;
}

/**
 * `project.paths.tempRoot`, defaulting to `'temp'`.
 *
 * @param {object} [config]
 * @returns {string}
 */
export function tempRootFrom(config) {
  if (!config || typeof config !== 'object') return 'temp';
  const tempRoot = config.project?.paths?.tempRoot;
  return typeof tempRoot === 'string' && tempRoot.length > 0
    ? tempRoot
    : 'temp';
}

/** Holds close gate logs and terse-result detail dumps. */
export const ORCHESTRATION_DIRNAME = 'orchestration';

/**
 * @param {object} [config]
 * @returns {string}
 */
export function orchestrationLogDir(config) {
  return path.join(anchorTempRoot(tempRootFrom(config)), ORCHESTRATION_DIRNAME);
}

/**
 * Shared by the gate-log writer and `deliver-recover.js`, which reads its
 * freshness to tell a live close from a dead one.
 *
 * @param {number|null} sid
 * @returns {string}
 */
function closeGateLogName(sid) {
  return `close-gates-${sid ?? 'unknown'}.log`;
}

/**
 * @param {number|null} sid
 * @param {object} [config]
 * @returns {string}
 */
export function closeGateLogPath(sid, config) {
  return path.join(orchestrationLogDir(config), closeGateLogName(sid));
}

/**
 * @param {number} sid
 * @returns {string}
 */
function storyTerminalEnvelopeName(sid) {
  return `story-deliver-terminal-${storyId(sid)}.json`;
}

/**
 * A sibling of the gate log: `deliver-recover.js` reads the pair together to
 * tell a finished close from a live one.
 *
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export function storyTerminalEnvelopePath(sid, config) {
  return path.join(orchestrationLogDir(config), storyTerminalEnvelopeName(sid));
}

const runId = (id) => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`[temp-paths] runId must be a positive integer; got ${id}`);
  }
  return id;
};

/** `null` is the standalone-Story sentinel. */
const storyEpicId = (id) => {
  if (id === null) return null;
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[temp-paths] epicId must be a positive integer or null; got ${id}`,
    );
  }
  return id;
};

const storyId = (id) => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[temp-paths] storyId must be a positive integer; got ${id}`,
    );
  }
  return id;
};

const artifactName = (name) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('[temp-paths] artifact name must be a non-empty string');
  }
  // Reject traversal; backslashes too, so `..\foo` cannot pass on Windows.
  if (name.includes('/') || name.includes('\\') || name === '..') {
    throw new Error(
      `[temp-paths] artifact name must not contain path separators; got ${JSON.stringify(name)}`,
    );
  }
  return name;
};

/**
 * @param {number} rid
 * @param {object} [config]
 * @returns {string}
 */
export function runTempDir(rid, config) {
  return path.join(anchorTempRoot(tempRootFrom(config)), `run-${runId(rid)}`);
}

/**
 * `eid === null` routes to `<tempRoot>/standalone/stories/story-<sid>/`.
 *
 * @param {number|null} eid
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export function storyTempDir(eid, sid, config) {
  const checkedEid = storyEpicId(eid);
  const parent =
    checkedEid === null
      ? path.join(anchorTempRoot(tempRootFrom(config)), STANDALONE_DIRNAME)
      : runTempDir(checkedEid, config);
  return path.join(parent, STORIES_DIRNAME, `story-${storyId(sid)}`);
}

/** Exported so stream discovery names the same file the writer does. */
export const SIGNALS_BASENAME = 'signals.ndjson';

/**
 * @param {number} eid
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export function signalsFile(eid, sid, config) {
  return path.join(storyTempDir(eid, sid, config), SIGNALS_BASENAME);
}

export const STANDALONE_DIRNAME = 'standalone';

export const STORIES_DIRNAME = 'stories';

/**
 * For the discovery walk only; everything else uses a named helper.
 *
 * @param {object} [config]
 * @returns {string}
 */
export function resolvedTempRoot(config) {
  return anchorTempRoot(tempRootFrom(config));
}

/**
 * Story-scope ledger; `eid === null` routes to the standalone subtree.
 *
 * @param {number|null} eid
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export const storyLedgerPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'lifecycle.ndjson', config);

/**
 * Escape hatch for a non-canonical run-level artifact.
 *
 * @param {number} eid
 * @param {string} name
 * @param {object} [config]
 * @returns {string}
 */
export function runArtifactPath(eid, name, config) {
  return path.join(runTempDir(eid, config), artifactName(name));
}

/**
 * @param {number} eid
 * @param {number} sid
 * @param {string} name
 * @param {object} [config]
 * @returns {string}
 */
function storyArtifactPath(eid, sid, name, config) {
  return path.join(storyTempDir(eid, sid, config), artifactName(name));
}

/**
 * Append-only lifecycle ledger; one record per merge-terminal outcome.
 *
 * @param {number} eid
 * @param {object} [config]
 * @returns {string}
 */
export const runLedgerPath = (eid, config) =>
  runArtifactPath(eid, 'lifecycle.ndjson', config);

export const storyManifestPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'manifest.md', config);
