// tests/lib/orchestration/lifecycle/activation/legacy-shims.test.js
/**
 * Legacy close-tail CLI shim invariants — Story #2319 / Task #2329.
 *
 * The Epic #2306 acceptance pinned each close-tail legacy script to a
 * "pure emit shim" shape: <50 source lines, exactly one `bus.emit`
 * call site, no leakage of removed helpers. This test file is the
 * load-bearing check that pins those invariants in tree for the shims
 * that still exist — and pins the un-shimming of any that have grown
 * real behaviour back.
 *
 * Historical entries that were deleted with their backing scripts in
 * Epic #2307 (Story #2432 / Task #2442) once the `/epic-deliver`
 * workflow markdown was rewritten (Story #2425) to invoke
 * `lifecycle-emit.js` directly instead of the shim CLIs:
 *   - `epic-deliver-finalize.js`     (Story #2319 / Task #2329)
 *   - `epic-deliver-automerge.js`    (Story #2336 / Task #2340)
 *   - `epic-deliver-cleanup.js`      (Story #2338 / Task #2342)
 *
 * `pr-watch-with-update.js` was a fourth shim until Story #3902
 * un-shimmed it. The empty-bus emit watched nothing, so Phase 8
 * advanced to auto-merge with CI red or still running. It now polls the
 * required checks to a terminal state via the shared `watchPrToTerminal`
 * primitive and exits non-zero unless every required check is green. The
 * `UN_SHIMMED` table below pins that it is NO LONGER a thin emit shim, so
 * a future regression that re-collapses it to an empty bus fails here.
 * Its real behaviour is pinned by
 * `tests/lib/orchestration/lifecycle/pr-watch-with-update.test.js`.
 *
 * The `SHIM_INVARIANTS` table is now empty; it stays in tree so a future
 * legitimate shim can append an entry and inherit the same assertions.
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

/** @type {Array<{label: string, file: string, event: string, forbiddenIdentifiers: string[]}>} */
const SHIM_INVARIANTS = [];

/**
 * Former shims that have been un-shimmed back into real implementations.
 * Each entry pins that the file is no longer a thin emit shim, so a
 * regression that re-collapses it (the exact defect Story #3902 fixed)
 * fails here loudly.
 */
const UN_SHIMMED = [
  {
    label: 'pr-watch-with-update.js',
    file: path.join(SCRIPTS_DIR, 'pr-watch-with-update.js'),
    // The real CLI delegates the poll + BEHIND-recovery loop to the
    // shared primitive; a re-shimmed empty-bus version would lose this.
    requiredIdentifier: 'watchPrToTerminal',
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

describe('un-shimmed close-tail CLIs are not empty emit shims', () => {
  for (const { label, file, requiredIdentifier } of UN_SHIMMED) {
    describe(label, () => {
      const source = readFileSync(file, 'utf8');

      it('does not emit into a lifecycle bus (no empty-bus shim)', () => {
        assert.ok(
          !source.includes('createBus') && !/\.emit\s*\(/.test(source),
          `${label} must not re-collapse to a lifecycle-bus emit shim.`,
        );
      });

      it(`references ${requiredIdentifier} (real watch behaviour)`, () => {
        assert.ok(
          source.includes(requiredIdentifier),
          `${label} must delegate to '${requiredIdentifier}'.`,
        );
      });
    });
  }
});
