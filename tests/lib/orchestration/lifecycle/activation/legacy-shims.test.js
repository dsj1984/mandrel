// tests/lib/orchestration/lifecycle/activation/legacy-shims.test.js
/**
 * Legacy close-tail CLI shim invariants — Story #2319 / Task #2329.
 *
 * The Epic #2306 acceptance pinned each close-tail legacy script to a
 * "pure emit shim" shape: <50 source lines, exactly one `bus.emit`
 * call site, no leakage of removed helpers. This test file is the
 * load-bearing check that pins those invariants in tree for the shims
 * that still exist.
 *
 * Currently exercised:
 *   - `pr-watch-with-update.js`      (Story #2327 / Task #2332)
 *
 * Historical entries that were deleted with their backing scripts in
 * Epic #2307 (Story #2432 / Task #2442) once the `/epic-deliver`
 * workflow markdown was rewritten (Story #2425) to invoke
 * `lifecycle-emit.js` directly instead of the shim CLIs:
 *   - `epic-deliver-finalize.js`     (Story #2319 / Task #2329)
 *   - `epic-deliver-automerge.js`    (Story #2336 / Task #2340)
 *   - `epic-deliver-cleanup.js`      (Story #2338 / Task #2342)
 *
 * Each addition appends an entry to the `SHIM_INVARIANTS` table below
 * so the same assertions guard them.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '.agents',
  'scripts',
);

const SHIM_INVARIANTS = [
  {
    // Story #2327 / Task #2332 — collapsed from 371 lines to a thin
    // emit shim. The Watcher listener owns the required-check poll
    // loop AND the mergeStateStatus: BEHIND auto-recovery.
    label: 'pr-watch-with-update.js',
    file: path.join(SCRIPTS_DIR, 'pr-watch-with-update.js'),
    event: 'pr.created',
    forbiddenIdentifiers: [
      // Legacy helper exports that lived in the watch-and-recover CLI.
      'runPrWatchWithUpdate',
      'parsePrWatchArgs',
      'classifyPrWatchInvocation',
      'classifyPollResult',
      'normalizeCheckResult',
      'BEHIND_MERGE_STATE',
      'CLEAN_MERGE_STATES',
      'GREEN_RESULTS',
      'FAILURE_RESULTS',
      'DEFAULT_MAX_UPDATES',
      'DEFAULT_POLL_INTERVAL_MS',
      // Side-effect surface that must not survive the neutering.
      'update-branch',
    ],
  },
];

describe('close-tail legacy CLI shim invariants', () => {
  for (const { label, file, event, forbiddenIdentifiers } of SHIM_INVARIANTS) {
    describe(label, () => {
      const source = readFileSync(file, 'utf8');
      const lineCount = source.split(/\r?\n/).length;

      it('is under 50 source lines', () => {
        assert.ok(
          lineCount < 50,
          `${label} must be a thin emit shim (<50 lines); found ${lineCount}.`,
        );
      });

      it('contains exactly one bus.emit call', () => {
        const matches = source.match(/\.emit\s*\(/g) ?? [];
        assert.equal(
          matches.length,
          1,
          `${label} must contain exactly one .emit(…) call site; found ${matches.length}.`,
        );
      });

      it(`emits ${event}`, () => {
        assert.ok(
          source.includes(`'${event}'`) || source.includes(`"${event}"`),
          `${label} must emit the canonical entry event ${event}.`,
        );
      });

      for (const identifier of forbiddenIdentifiers) {
        it(`does not reference ${identifier}`, () => {
          assert.ok(
            !source.includes(identifier),
            `${label} must not reference removed helper '${identifier}'.`,
          );
        });
      }
    });
  }
});
