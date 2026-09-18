/**
 * maintainability-unscorable.js — report files the MI kernel cannot analyse.
 * They get no baseline row (a phantom `mi: 0` would poison the rollup), but
 * dropping them silently makes them indistinguishable from unseeded files.
 */

import { Logger } from './Logger.js';

/**
 * @param {Array<{ relPath: string, unscorable?: boolean, reason?: string|null }>} perFile
 * @returns {number} how many files were unscorable, for the caller's own use.
 */
export function reportUnscorable(perFile) {
  const unscorable = (perFile ?? []).filter((entry) => entry?.unscorable);
  if (unscorable.length === 0) return 0;

  for (const { relPath, reason } of unscorable) {
    Logger.error(
      `[Maintainability] UNSCORABLE ${relPath}: ${reason ?? 'unknown kernel failure'}`,
    );
  }
  Logger.error(
    `[Maintainability] ${unscorable.length} file(s) could not be scored and will have ` +
      'no baseline row, so the maintainability gate cannot see them. If the cause is a ' +
      'kernel AST gap, add a handler in lib/escomplex-ast-compat.js rather than an ' +
      'allowlist entry.',
  );
  return unscorable.length;
}

/**
 * Tests for a number, not `score !== null` (which lets `undefined` through);
 * unscorable entries carry a sentinel, not an index.
 *
 * @param {{ score?: number|null, unscorable?: boolean }} entry
 * @returns {boolean}
 */
export function isScored(entry) {
  return typeof entry?.score === 'number' && !entry.unscorable;
}
