/**
 * The `.agentrc.local.json` overlay, shared by the runtime resolver and the
 * read-only `sync-agentrc` check so both validate the same effective config.
 */

import path from 'node:path';

export const LOCAL_AGENTRC = '.agentrc.local.json';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge plain objects for the overlay. Arrays and scalars from
 * `override` replace the base value at that key.
 *
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
export function deepMergeObjects(base, override) {
  if (!isPlainObject(override)) return override;
  if (!isPlainObject(base)) return { ...override };
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = mergeValue(base[key], override[key]);
  }
  return out;
}

function mergeValue(baseVal, overrideVal) {
  if (isPlainObject(overrideVal) && isPlainObject(baseVal)) {
    return deepMergeObjects(baseVal, overrideVal);
  }
  return overrideVal;
}

/**
 * Merge the project's overlay, when present, over the committed config.
 * Throws a parse error naming `.agentrc.local.json`.
 *
 * @param {{ fsImpl: typeof import('node:fs'), projectRoot: string, committed: object }} opts
 * @returns {{ effective: object, localPath: string|null }}
 */
export function applyLocalOverlay({ fsImpl, projectRoot, committed }) {
  const localPath = path.join(projectRoot, LOCAL_AGENTRC);
  if (!fsImpl.existsSync(localPath)) {
    return { effective: committed, localPath: null };
  }
  const local = parseOverlay(fsImpl, localPath);
  return { effective: deepMergeObjects(committed, local), localPath };
}

function parseOverlay(fsImpl, localPath) {
  try {
    return JSON.parse(fsImpl.readFileSync(localPath, 'utf8'));
  } catch (err) {
    const wrapped = new Error(
      `Failed to parse ${LOCAL_AGENTRC}: ${err.message}`,
    );
    wrapped.localPath = localPath;
    throw wrapped;
  }
}

const OPERATOR_HANDLE_REMEDY = `set github.operatorHandle in the gitignored ${LOCAL_AGENTRC} (per-operator), or keep the "@[USERNAME]" placeholder committed in .agentrc.json`;

function isMissingOperatorHandle(e) {
  return (
    e.keyword === 'required' &&
    e.instancePath === '/github' &&
    e.params?.missingProperty === 'operatorHandle'
  );
}

/**
 * Render AJV errors for an `.agentrc` validation failure, one string per
 * error. A missing `github.operatorHandle` carries where to put it.
 *
 * @param {Array<{ instancePath?: string, message?: string, keyword?: string, params?: object }>|null|undefined} errors
 * @returns {string[]}
 */
export function formatAgentrcErrors(errors) {
  return (errors || []).map((e) => {
    const line = `${e.instancePath || '(root)'} ${e.message}`;
    return isMissingOperatorHandle(e)
      ? `${line} — ${OPERATOR_HANDLE_REMEDY}`
      : line;
  });
}
