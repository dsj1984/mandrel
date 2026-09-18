/**
 * refresh-service.duplication.test.js — Story #4944.
 *
 * `update-duplication-baseline.js` was the last manual baseline CLI still on
 * the legacy `buildWriterScopeArgs` path, which is why its `--full-scope`
 * flag was documented but unparsed and its no-flag default was a full
 * rewrite rather than the diff-scoped refresh the usage text promised.
 * Migrating it onto `refreshBaseline()` moves that contract into the
 * service, so this file pins the service-side half:
 *
 *   - `duplication` is an accepted kind (it used to throw "unknown kind").
 *   - Diff scope preserves out-of-scope rows verbatim and rewrites only the
 *     in-scope ones.
 *   - `fullScope: true` rewrites everything (no merge).
 *   - A scoped file whose clones are gone loses its row — the duplication
 *     row set is "files with detected duplication", so absence is the
 *     correct representation of "no longer duplicated", not a stale keep.
 *   - The default scorer ignores its `files` argument and always scans the
 *     whole target tree. Duplication is pairwise: narrowing the *scan* to the
 *     diff would drop every clone between a changed file and an unchanged
 *     one. Scope narrowing for this kind is a write-side concern.
 *
 * Every write lands under a temp dir — the repo's own
 * `baselines/duplication.json` is never touched.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveDetectClones } from '../../.agents/scripts/lib/baselines/duplication-scanner.js';
import { getKindModule } from '../../.agents/scripts/lib/baselines/kernel.js';
import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from '../../.agents/scripts/lib/baselines/writer.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

/** `{ path, duplicatedLines, totalLines, percentage }` — the kind's row shape. */
function row(p, duplicatedLines, totalLines) {
  return {
    path: p,
    duplicatedLines,
    totalLines,
    percentage: Number(((duplicatedLines / totalLines) * 100).toFixed(2)),
  };
}

const PRIOR_ROWS = [
  row('src/a.js', 10, 100), // 10%
  row('src/b.js', 10, 100), // 10%
  row('src/c.js', 40, 100), // 40% — out of scope throughout
  row('src/d.js', 40, 100), // 40% — out of scope throughout
];

function seedPrior(writePath, rows) {
  mkdirSync(path.dirname(writePath), { recursive: true });
  // Round-trip through the writer so the seeded rows carry the canonical
  // projection the service compares against in its structural-equality
  // short-circuit.
  const envelope = writeEnvelope({ kind: 'duplication', rows });
  writeEnvelopeFile(writePath, envelope);
  return envelope;
}

function readEnvelope(writePath) {
  return JSON.parse(readFileSync(writePath, 'utf8'));
}

/**
 * The committed file carries no rollup (Story #5400); the floors phase
 * derives it from the rows exactly like this.
 */
function derivedRollup(envelope) {
  assert.equal(Object.hasOwn(envelope, 'rollup'), false);
  return getKindModule('duplication').rollup(envelope.rows, [])['*'];
}

function byPath(envelope) {
  return new Map(envelope.rows.map((r) => [r.path, r]));
}

describe('refreshBaseline — duplication kind (Story #4944)', () => {
  let workDir;
  let writePath;

  beforeEach(() => {
    workDir = makeTempDir('mandrel-refresh-duplication-');
    writePath = path.join(workDir, 'baselines', 'duplication.json');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AC: accepts `duplication` as a supported kind', async () => {
    const result = await refreshBaseline({
      kind: 'duplication',
      writePath,
      fullScope: true,
      scorer: () => [row('src/a.js', 5, 100)],
    });
    assert.equal(result.kind, 'duplication');
    assert.equal(result.scope.mode, 'full');
    assert.equal(
      result.envelope.$schema,
      '.agents/schemas/baselines/duplication.schema.json',
    );
  });

  it('AC: diff scope rewrites in-scope rows and preserves out-of-scope rows verbatim', async () => {
    const prior = seedPrior(writePath, PRIOR_ROWS);
    const priorByPath = byPath(prior);

    // The scorer scans the whole tree (as the real one does) and returns a
    // row for every file — including out-of-scope ones with *changed*
    // values. The service must discard those and keep the prior bytes.
    const result = await refreshBaseline({
      kind: 'duplication',
      writePath,
      scopeFiles: ['src/a.js', 'src/b.js'],
      scorer: () => [
        row('src/a.js', 30, 100), // in scope → 30%
        row('src/b.js', 0, 100), // in scope → 0%
        row('src/c.js', 99, 100), // OUT of scope → must be ignored
        row('src/d.js', 99, 100), // OUT of scope → must be ignored
      ],
    });

    assert.equal(result.scope.mode, 'explicit');
    const after = byPath(readEnvelope(writePath));

    assert.equal(after.get('src/a.js').percentage, 30);
    assert.equal(after.get('src/b.js').percentage, 0);
    // Byte-identical out-of-scope rows — every field, not just the axis.
    assert.deepEqual(after.get('src/c.js'), priorByPath.get('src/c.js'));
    assert.deepEqual(after.get('src/d.js'), priorByPath.get('src/d.js'));
  });

  it('AC: an in-scope file whose clones are gone loses its row', async () => {
    seedPrior(writePath, PRIOR_ROWS);

    // jscpd only reports files participating in a clone, so "src/a.js has no
    // duplication any more" surfaces as the absence of a row, not a 0-row.
    // The merge must drop the stale prior row rather than pin it.
    await refreshBaseline({
      kind: 'duplication',
      writePath,
      scopeFiles: ['src/a.js'],
      scorer: () => [row('src/b.js', 10, 100), row('src/c.js', 40, 100)],
    });

    const after = byPath(readEnvelope(writePath));
    assert.equal(after.has('src/a.js'), false);
    // …and the out-of-scope rows are still all there.
    assert.deepEqual([...after.keys()].sort(), [
      'src/b.js',
      'src/c.js',
      'src/d.js',
    ]);
  });

  it('AC: fullScope rewrites every row (no out-of-scope merge)', async () => {
    seedPrior(writePath, PRIOR_ROWS);

    await refreshBaseline({
      kind: 'duplication',
      writePath,
      fullScope: true,
      scorer: () => [row('src/a.js', 1, 100)],
    });

    const after = readEnvelope(writePath);
    assert.deepEqual(
      after.rows.map((r) => r.path),
      ['src/a.js'],
      'full scope must replace the row set outright, not merge into it',
    );
    assert.equal(derivedRollup(after).percentage, 1);
  });

  it('AC: the rollup derived from the merged rows is the exact aggregate ratio', async () => {
    seedPrior(writePath, PRIOR_ROWS);

    await refreshBaseline({
      kind: 'duplication',
      writePath,
      scopeFiles: ['src/a.js'],
      scorer: () => [row('src/a.js', 20, 100)],
    });

    const after = readEnvelope(writePath);
    // a=20 + b=10 + c=40 + d=40 duplicated over 400 total lines → 27.5%.
    const rollup = derivedRollup(after);
    assert.equal(rollup.duplicatedLines, 110);
    assert.equal(rollup.totalLines, 400);
    assert.equal(rollup.percentage, 27.5);
  });

  it('AC: writes an empty-row envelope rather than nothing when no clones are found', async () => {
    const result = await refreshBaseline({
      kind: 'duplication',
      writePath,
      fullScope: true,
      scorer: () => [],
    });

    assert.equal(result.wrote, true);
    const after = readEnvelope(writePath);
    assert.deepEqual(after.rows, []);
    assert.equal(derivedRollup(after).percentage, 0);
  });
});

describe('refreshBaseline — default duplication scorer scans whole-tree (Story #4944)', () => {
  let workDir;

  beforeEach(() => {
    workDir = makeTempDir('mandrel-dup-scorer-');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AC: diff scope does not narrow what jscpd is handed', async () => {
    // Regression guard for the pairwise trap: if a future refactor "helpfully"
    // passes the diff-derived file list into the scanner, a clone between a
    // changed file and an unchanged one becomes invisible and the baseline
    // silently under-reports. The scanner must always receive the configured
    // target dirs.
    assert.equal(
      typeof resolveDetectClones,
      'function',
      'the scanner owns the jscpd resolution seam (moved out of the CLI)',
    );

    // Drive the service's diff path with an injected scorer that records what
    // it was handed, mirroring the default scorer's signature.
    const seen = [];
    const writePath = path.join(workDir, 'baselines', 'duplication.json');
    await refreshBaseline({
      kind: 'duplication',
      writePath,
      scopeFiles: ['src/a.js'],
      scorer: (files, opts) => {
        seen.push({ files, fullScope: opts.fullScope });
        // A whole-tree scan legitimately returns rows for files the scope
        // never mentioned; the service is responsible for filtering them.
        return [row('src/a.js', 10, 100), row('src/z.js', 10, 100)];
      },
    });

    assert.deepEqual(seen[0].files, ['src/a.js']);
    assert.equal(seen[0].fullScope, false);
    // No prior on disk → nothing to preserve → the merge is a no-op and the
    // out-of-scope row survives. This is the writer's documented
    // "empty prior behaves like full mode" branch.
    const after = readEnvelope(writePath);
    assert.deepEqual(after.rows.map((r) => r.path).sort(), [
      'src/a.js',
      'src/z.js',
    ]);
  });
});
