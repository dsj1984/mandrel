/**
 * lib/audit-suite/dispatch-checklist.js — the deliver-dispatch call site for
 * write-time checklist threading (Story #4627, activating Epic #4405's
 * Story #4410 machinery).
 *
 * `checklist-threading.js#buildChecklistPayload` was built and unit-tested but
 * had **zero production call sites**: nothing derived a footprint, assembled
 * the payload, or handed a `checklistPath` to the spawned Story worker. This
 * module is that call site. Given a Story's predicted footprint (its
 * `changes[]` / `references[]` path entries), it assembles the footprint-matched
 * local-lens checklist payload, writes it to the run's temp dir, and returns
 * the `checklistPath` the deliver-story spawn threads into the maker's prompt
 * (the same way the docs digest reaches the worker as `docsDigestPath`).
 *
 * Pure modulo the single file write, which is an injectable seam
 * (`writeFileFn`) so the builder is unit-testable without touching disk. No
 * git, no provider, no network — the footprint is the planner's *prediction*,
 * not a diff, so no repository read is involved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildChecklistPayload } from './checklist-threading.js';

/**
 * Extract clean path strings from a Story's `changes[]` / `references[]`
 * entries. Accepts both the parsed `{ path, assumption }` PathEntry shape and a
 * bare `string`, dropping empty / non-string entries.
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
 * Derive the predicted footprint the checklist matcher reads: the union of a
 * Story's `changes[]` and `references[]` path entries, in that order.
 *
 * Module-local: a detail of {@link buildDispatchChecklist}, exercised through
 * that public entry point (assert the footprint the injected payload builder
 * received) rather than imported directly, so it adds no test-only public
 * export the dead-export ratchet would flag.
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
 * Default file writer: ensure the parent dir exists, then write the payload.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function defaultWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Build the write-time checklist payload for a Story and write it to the run's
 * temp dir, returning the `checklistPath` the deliver-story spawn threads.
 *
 * When the footprint matches no local lens (the common case for a
 * docs-only or infra-only Story), nothing is written and `checklistPath` is
 * `null` — the worker then runs with no write-time checklist, exactly as it
 * does today, and lens-aware coverage still runs maker-blind at Story-scope
 * close.
 *
 * @param {object} args
 * @param {number|string} args.storyId — names the payload file.
 * @param {unknown} [args.changes] — the Story's `changes[]` path entries.
 * @param {unknown} [args.references] — the Story's `references[]` path entries.
 * @param {string} args.runTempDir — the run temp dir the payload is written to.
 * @param {number} [args.tokenBudget] — override the payload cap.
 * @param {typeof buildChecklistPayload} [args.buildPayloadFn] — injectable seam.
 * @param {(filePath: string, content: string) => void} [args.writeFileFn] —
 *   injectable write seam (defaults to the on-disk writer).
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
