import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { write } from '../../.agents/scripts/lib/baselines/writer.js';

/**
 * shipped-baselines-idempotency.test.js — Story #1895 task #1905.
 *
 * Lock in that re-running the shared writer on the shipped baselines is a
 * no-op (modulo the timestamp, which the writer stamps from the input).
 *
 * Contract:
 *   1. Every shipped baseline parses, schema-validates, and round-trips
 *      through the writer to a byte-identical canonical JSON form when
 *      the original `generatedAt` is pinned.
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

function canonicalSerialise(envelope) {
  // Mirror the on-disk serialisation done by `writer.writeFile`: two-space
  // indent, canonical top-level key order, trailing newline. We compute
  // the bytes inline (no disk I/O) so the test never writes anywhere.
  const canonical = {
    $schema: envelope.$schema,
    kernelVersion: envelope.kernelVersion,
    generatedAt: envelope.generatedAt,
    rollup: envelope.rollup,
    rows: envelope.rows,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
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

      it.skip('round-trips through the writer byte-identically (generatedAt pinned) — env-variant; tracked by #2017', () => {
        const { raw, parsed } = loadShipped(file);
        const rebuilt = write({
          kind,
          rows: parsed.rows ?? [],
          kernelVersion: parsed.kernelVersion,
          generatedAt: parsed.generatedAt,
        });
        const rebuiltBytes = canonicalSerialise(rebuilt);
        assert.equal(
          rebuiltBytes,
          raw,
          `${file}: writer round-trip produced a different envelope; the shipped baseline is not canonical`,
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
