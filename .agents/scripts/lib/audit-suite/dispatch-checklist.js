/**
 * Deliver-dispatch call site for checklist threading: builds the payload from
 * a Story's predicted `changes[]` + `references[]` footprint, writes it to
 * the run temp dir, and returns the `checklistPath` the worker spawn threads.
 * The footprint is a prediction, not a diff: no git, provider, or network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildChecklistPayload } from './checklist-threading.js';

/**
 * Accepts `{ path }` entries or bare strings.
 *
 * @param {unknown} entries
 * @returns {string[]}
 */
function footprintFromEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .filter((p) => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
}

/**
 * Module-local so it adds no test-only export for the dead-export ratchet.
 *
 * @param {{ changes?: unknown, references?: unknown }} [args]
 * @returns {string[]}
 */
function deriveDispatchFootprint({ changes, references } = {}) {
  return [
    ...footprintFromEntries(changes),
    ...footprintFromEntries(references),
  ];
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function defaultWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * No matched lens → nothing written, `checklistPath: null`.
 *
 * @param {object} args
 * @param {number|string} args.storyId
 * @param {unknown} [args.changes]
 * @param {unknown} [args.references]
 * @param {string} args.runTempDir
 * @param {number} [args.tokenBudget]
 * @param {typeof buildChecklistPayload} [args.buildPayloadFn]
 * @param {(filePath: string, content: string) => void} [args.writeFileFn]
 * @returns {{
 *   checklistPath: string|null,
 *   skipped: boolean,
 *   matchedLenses: string[],
 *   includedLenses: string[],
 *   droppedLenses: string[],
 * }}
 */
export function buildDispatchChecklist({
  storyId,
  changes,
  references,
  runTempDir,
  tokenBudget,
  buildPayloadFn = buildChecklistPayload,
  writeFileFn = defaultWriteFile,
}) {
  const footprint = deriveDispatchFootprint({ changes, references });
  const result = buildPayloadFn({
    footprint,
    ...(tokenBudget != null ? { tokenBudget } : {}),
  });
  const accounting = {
    matchedLenses: result.matchedLenses,
    includedLenses: result.includedLenses,
    droppedLenses: result.droppedLenses,
  };

  if (!result.payload || result.includedLenses.length === 0) {
    return { checklistPath: null, skipped: true, ...accounting };
  }

  if (!runTempDir) {
    throw new TypeError(
      'buildDispatchChecklist: runTempDir is required to write a non-empty checklist payload',
    );
  }

  const checklistPath = path.join(runTempDir, `story-${storyId}-checklist.md`);
  writeFileFn(checklistPath, result.payload);
  return { checklistPath, skipped: false, ...accounting };
}
