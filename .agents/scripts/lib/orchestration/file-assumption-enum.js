/**
 * file-assumption-enum.js — cycle-free leaf module for the canonical
 * file-assumption enum.
 *
 * Story #3331 relocated `FILE_ASSUMPTION_VALUES` here so the canonical
 * Story-body parser (`../story-body/story-body.js`) can reach the enum
 * without importing the Task-named `task-body-validator.js`. The runtime
 * file-assumption gate (`./file-assumptions.js`) imports `parseStoryBody`
 * from `story-body.js`; routing the enum import through this leaf keeps
 * the dependency graph acyclic.
 *
 * This module imports nothing. It is the single source of truth for the
 * assumption vocabulary; `story-body.js`, `task-body-validator.js`, and
 * `file-assumptions.js` all import the enum from here. `file-assumptions.js`
 * additionally re-exports it so legacy callers (and
 * `tests/file-assumptions.test.js`) keep resolving the symbol from the
 * runtime gate.
 *
 * Canonical assumption values a path entry may declare:
 *   - `creates`            — the path does not yet exist; the Story creates it.
 *   - `refactors-existing` — the path exists; the Story rewrites it in place.
 *   - `exists`             — the path is read but not modified (e.g. a fixture).
 *   - `deletes`            — the path exists; the Story removes it.
 */

export const FILE_ASSUMPTION_VALUES = Object.freeze([
  'creates',
  'refactors-existing',
  'exists',
  'deletes',
]);
