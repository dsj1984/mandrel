/**
 * Pure-I/O baseline-JSON store: encapsulates the Story #1120 `--epic-ref`
 * fallback chain (try `readAtRef` → fall back to fs with a warning) and
 * an atomic tmp-rename write. Shape validation stays in each gate.
 * Missing files throw `BaselineNotFoundError`; write failures throw
 * `BaselineWriteError` — no swallowing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readBaselineAtRef as defaultReadAtRef } from '../baseline-loader.js';
import { Logger } from '../Logger.js';

export class BaselineNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BaselineNotFoundError';
    Object.assign(this, details);
  }
}

export class BaselineWriteError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BaselineWriteError';
    Object.assign(this, details);
  }
}

function absPath(baselinePath, projectRoot) {
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    throw new TypeError('[baseline-store] baselinePath is required');
  }
  return path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(projectRoot ?? process.cwd(), baselinePath);
}

// Default working-tree reader. Throws `BaselineNotFoundError` when absent.
function defaultReadFromTree({ baselinePath, projectRoot } = {}) {
  const abs = absPath(baselinePath, projectRoot);
  if (!fs.existsSync(abs)) {
    throw new BaselineNotFoundError(`baseline not found at ${baselinePath}`, {
      path: abs,
      baselinePath,
    });
  }
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/**
 * Load a baseline JSON file with the Story #1120 `--epic-ref` fallback
 * chain. Gates may supply a `readFromTree` to preserve a "missing →
 * empty" bootstrap (e.g. MI returns `{}`); otherwise the default throws
 * `BaselineNotFoundError`.
 */
export function loadBaseline({
  baselinePath,
  epicRef = null,
  projectRoot,
  readAtRef = defaultReadAtRef,
  readFromTree = defaultReadFromTree,
  logger = Logger,
  label = 'baseline-store',
} = {}) {
  if (epicRef) {
    try {
      const parsed = readAtRef(epicRef, baselinePath);
      if (parsed !== null && parsed !== undefined) return parsed;
    } catch (err) {
      logger.warn(
        `[${label}] ⚠ failed to read baseline at ref "${epicRef}": ${err?.message ?? err}. Falling back to working-tree read.`,
      );
    }
  }
  return readFromTree({ baselinePath, projectRoot });
}

/**
 * Atomic write via temp-file + rename. 2-space indent + trailing newline.
 */
export function writeBaseline({
  baselinePath,
  data,
  projectRoot,
  indent = 2,
} = {}) {
  const abs = absPath(baselinePath, projectRoot);
  const tmp = `${abs}.tmp`;
  try {
    const serialised = `${JSON.stringify(data, null, indent)}\n`;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, serialised, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw new BaselineWriteError(
      `[baseline-store] failed to write baseline at ${baselinePath}: ${err?.message ?? err}`,
      { path: abs, cause: err },
    );
  }
}
