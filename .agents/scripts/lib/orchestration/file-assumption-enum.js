/**
 * file-assumption-enum.js — the file-assumption vocabulary, in an import-free
 * leaf so `story-body.js` and `file-assumptions.js` stay acyclic.
 */

export const FILE_ASSUMPTION_VALUES = Object.freeze([
  'creates',
  'refactors-existing',
  'exists',
  'deletes',
]);
