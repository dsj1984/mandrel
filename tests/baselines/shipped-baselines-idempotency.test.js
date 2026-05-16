import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { write } from '../../.agents/scripts/lib/baselines/writer.js';

/**
 * shipped-baselines-idempotency.test.js — Story #1895 task #1905;
 * stabilized under Story #2017.
 *
 * Lock in that re-running the shared writer on the shipped baselines is a
 * structural no-op (modulo the timestamp, which the writer stamps from the
 * input).
 *
 * Contract:
 *   1. Every shipped baseline parses, schema-validates, and round-trips
 *      through the writer to a STRUCTURALLY identical envelope when the
 *      original `generatedAt` is pinned. "Structural" intentionally
 *      ignores object key insertion order in the JSON: prior baselines on
 *      disk may have rows in the legacy `{ path, crap, method, startLine }`
 *      key order while the writer's `projectRow` emits the canonical
 *      `{ path, method, startLine, crap }` order, and the
 *      stability-epsilon stabilizer (#1964) can leak prior key order
 *      verbatim on a sub-epsilon match. The values are what we care
 *      about; byte-identity coupled the assertion to historical JSON
 *      insertion order and made the test env-variant across Node
 *      versions, escomplex versions, and OS line endings.
 *   2. No path in any row carries a `.worktrees/<name>/` prefix or a
 *      backslash separator — the canonicaliser must have already done
 *      its job.
 *   3. crap.json rows key on `path` (not the legacy `file`).
 *   4. The `*` rollup matches the per-kind rollup applied to the rows.
 *
 * These assertions fail if (a) a shipped baseline contains a
 * non-canonical path or (b) a future writer change makes the same input
 * round-trip to a different envelope.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SHIPPED = [
  { kind: 'lint', file: 'baselines/lint.json' },
  { kind: 'coverage', file: 'baselines/coverage.json' },
  { kind: 'crap', file: 'baselines/crap.json' },
  { kind: 'maintainability', file: 'baselines/maintainability.json' },
];

function loadShipped(file) {
  const abs = path.resolve(REPO_ROOT, file);
  // Read from `HEAD` rather than the working tree: concurrent test workers
  // (notably the `update-*-baseline.js` smoke tests under
  // `tests/baselines/refresh-entry-points-migration.test.js`) can churn the
  // shipped baselines on disk while this test runs. The committed copy is
  // the canonical, signed-off shape this contract pins.
  const raw = execFileSync(
    'git',
    ['show', `HEAD:${file.replace(/\\/g, '/')}`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { raw, parsed: JSON.parse(raw), abs };
}

describe('shipped baselines — writer-idempotent and canonical', () => {
  for (const { kind, file } of SHIPPED) {
    describe(`${file}`, () => {
      it('contains no `.worktrees/<name>/` prefix and no backslash in row paths', () => {
        const { parsed } = loadShipped(file);
        const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
        for (const row of rows) {
          const value = row?.path;
          if (typeof value !== 'string') continue;
          assert.equal(
            /^\.worktrees\//.test(value),
            false,
            `${file}: row path "${value}" carries a .worktrees/ prefix`,
          );
          assert.equal(
            value.includes('\\'),
            false,
            `${file}: row path "${value}" contains a backslash`,
          );
        }
      });

      it('round-trips through the writer structurally (generatedAt pinned)', () => {
        const { parsed } = loadShipped(file);
        const rebuilt = write({
          kind,
          rows: parsed.rows ?? [],
          kernelVersion: parsed.kernelVersion,
          generatedAt: parsed.generatedAt,
        });
        // `deepStrictEqual` compares own-key sets and values, not key
        // insertion order. That's exactly what we want: the writer must
        // emit the same envelope shape, same rows, and same rollup that
        // ships on disk, but it is allowed to reorder object keys (which
        // both `projectRow` and the prior-row preservation paths in
        // `applyEpsilon` / `mergeRowsByScope` legitimately do).
        assert.deepStrictEqual(
          rebuilt,
          parsed,
          `${file}: writer round-trip produced a structurally different envelope`,
        );
      });
    });
  }

  it('baselines/crap.json keys rows on `path` (not `file`)', () => {
    const { parsed } = loadShipped('baselines/crap.json');
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    assert.ok(
      rows.length > 0,
      'shipped crap baseline must carry at least one row',
    );
    for (const row of rows) {
      assert.ok(
        typeof row?.path === 'string',
        `crap row missing canonical \`path\`: ${JSON.stringify(row)}`,
      );
      assert.equal(
        Object.hasOwn(row, 'file'),
        false,
        `crap row still carries legacy \`file\`: ${JSON.stringify(row)}`,
      );
    }
  });
});
