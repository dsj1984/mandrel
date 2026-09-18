// lib/migrations/helpers/retire-agentrc-key.js
/**
 * Scaffold for steps that strip a retired `.agentrc` key (its block is
 * `additionalProperties: false`, so a surviving key fails validation on
 * upgrade). The default sweep includes `.agentrc.local.json`: the resolver
 * merges it before validation. Prune depth is per-key, since pruning a
 * required block is a gratuitous edit. Builtins only: runs during `mandrel
 * update` before third-party packages are guaranteed present.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

export const AGENTRC_BASE_FILENAME = '.agentrc.json';

const AGENTRC_LOCAL_FILENAME = '.agentrc.local.json';

const AGENTRC_FILENAMES = Object.freeze([
  AGENTRC_BASE_FILENAME,
  AGENTRC_LOCAL_FILENAME,
]);

/**
 * @param {unknown} ctx
 * @param {string} filename
 * @returns {string}
 */
function resolveAgentrcPath(ctx, filename) {
  const projectRoot = ctx?.projectRoot ?? process.cwd();
  return path.join(projectRoot, filename);
}

/**
 * Absent or unparseable is the common case (no overlay), not an error.
 *
 * @param {unknown} ctx
 * @param {string} filename
 * @param {typeof nodeFs} fsImpl
 * @returns {object | null}
 */
function readAgentrcConfig(ctx, filename, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(resolveAgentrcPath(ctx, filename), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Every container along the key path; `null` if any level is missing.
 *
 * @param {object | null} config
 * @param {string[]} keyPath
 * @returns {object[] | null}
 */
function resolveContainers(config, keyPath) {
  if (!config || typeof config !== 'object') return null;
  const containers = [config];
  let cursor = config;
  for (const segment of keyPath.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== 'object') return null;
    containers.push(next);
    cursor = next;
  }
  return containers;
}

/**
 * @param {object | null} config
 * @param {string[]} keyPath
 * @returns {boolean}
 */
function hasKey(config, keyPath) {
  const containers = resolveContainers(config, keyPath);
  if (!containers) return false;
  const leafOwner = containers[containers.length - 1];
  return Object.hasOwn(leafOwner, keyPath[keyPath.length - 1]);
}

/**
 * Delete the leaf, then up to `pruneDepth` ancestors it left empty.
 *
 * @param {object} config
 * @param {{ path: string[], pruneDepth?: number }} key
 * @returns {void}
 */
function stripKey(config, key) {
  const keyPath = key.path;
  const containers = resolveContainers(config, keyPath);
  if (!containers) return;

  const leafOwner = containers[containers.length - 1];
  delete leafOwner[keyPath[keyPath.length - 1]];

  const pruneDepth = key.pruneDepth ?? 0;
  for (let level = 0; level < pruneDepth; level += 1) {
    const index = containers.length - 1 - level;
    const emptied = containers[index];
    const parent = containers[index - 1];
    if (!parent || Object.keys(emptied).length > 0) break;
    delete parent[keyPath[index - 1]];
  }
}

/**
 * `apply` rewrites only surfaces carrying a key, so a repeat pass never
 * reformats.
 *
 * @param {{
 *   version: string,
 *   description: string,
 *   filenames?: readonly string[],
 *   keys: Array<{ path: string[], pruneDepth?: number }>,
 * }} spec
 * @returns {{
 *   version: string,
 *   description: string,
 *   detect: (ctx?: { projectRoot?: string, fs?: typeof nodeFs }) => boolean,
 *   apply: (ctx?: { projectRoot?: string, fs?: typeof nodeFs }) => void,
 * }}
 */
export function createRetireAgentrcKeyStep({
  version,
  description,
  filenames = AGENTRC_FILENAMES,
  keys,
}) {
  const carriesRetiredKey = (config) =>
    keys.some((key) => hasKey(config, key.path));

  return {
    version,
    description,
    detect(ctx) {
      const fsImpl = ctx?.fs ?? nodeFs;
      return filenames.some((filename) =>
        carriesRetiredKey(readAgentrcConfig(ctx, filename, fsImpl)),
      );
    },
    apply(ctx) {
      const fsImpl = ctx?.fs ?? nodeFs;
      for (const filename of filenames) {
        const config = readAgentrcConfig(ctx, filename, fsImpl);
        if (!carriesRetiredKey(config)) continue;

        for (const key of keys) {
          if (hasKey(config, key.path)) stripKey(config, key);
        }

        fsImpl.writeFileSync(
          resolveAgentrcPath(ctx, filename),
          `${JSON.stringify(config, null, 2)}\n`,
        );
      }
    },
  };
}
