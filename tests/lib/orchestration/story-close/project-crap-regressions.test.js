import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  diffCrapBaselines,
  projectCrapRegressions,
} from '../../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js';

/**
 * Story #1291 / Task #1321 — fixture-pinned tests for the `check-crap`
 * projector. Asserts:
 *
 *   1. With a touchedFiles set that includes `lib/touched.js`, the projector
 *      returns at least one regression row for `doWork` (CRAP rose from 8 →
 *      14, crossing the integer threshold and clearing tolerance).
 *   2. With a touchedFiles set that excludes `lib/touched.js`, no rows are
 *      returned — sibling drift on `lib/sibling.js::other` must not bleed
 *      through (the story never touched it).
 *
 * The fixture envelope intentionally mirrors the on-disk `baselines/crap.json`
 * shape (kernelVersion / escomplexVersion / rows) so the test pins the same
 * data path `readBaselineAtRef` would hand `projectCrapRegressions` in
 * production.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'crap-regression.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function makeReadBaselineAtRef({ baselineRef, headRef }) {
  return (ref) => {
    if (ref === baselineRef) return fixture.baseline;
    if (ref === headRef) return fixture.head;
    throw new Error(`unexpected ref: ${ref}`);
  };
}

describe('projectCrapRegressions — fixture pair', () => {
  it('returns at least one regression row when the touched function crossed the CRAP tolerance', () => {
    const baselineRef = 'origin/epic/1143';
    const headRef = 'story-1291';
    const rows = projectCrapRegressions({
      touchedFiles: new Set(['lib/touched.js']),
      baselineRef,
      headRef,
      baselinePath: 'baselines/crap.json',
      readBaselineAtRef: makeReadBaselineAtRef({ baselineRef, headRef }),
    });
    assert.ok(
      rows.length >= 1,
      `expected ≥1 regression row, got ${rows.length}`,
    );
    const doWork = rows.find(
      (r) => r.file === 'lib/touched.js' && r.method === 'doWork',
    );
    assert.ok(doWork, 'doWork regression row should be present');
    assert.equal(doWork.baseline, 8);
    assert.equal(doWork.crap, 14);
    assert.equal(doWork.projected, 14);
    assert.equal(doWork.path, 'lib/touched.js');
    assert.equal(doWork.startLine, 14);
    // The trivial method drifted by 0.02 — within tolerance, must not appear.
    const trivial = rows.find((r) => r.method === 'trivial');
    assert.equal(
      trivial,
      undefined,
      'trivial method must stay under tolerance',
    );
  });

  it('returns zero rows when touchedFiles excludes the regressed file', () => {
    const baselineRef = 'origin/epic/1143';
    const headRef = 'story-1291';
    const rows = projectCrapRegressions({
      touchedFiles: new Set(['lib/elsewhere.js']),
      baselineRef,
      headRef,
      baselinePath: 'baselines/crap.json',
      readBaselineAtRef: makeReadBaselineAtRef({ baselineRef, headRef }),
    });
    assert.deepEqual(rows, []);
  });

  it('swallows read failures at either ref and returns []', () => {
    const rows = projectCrapRegressions({
      touchedFiles: new Set(['lib/touched.js']),
      baselineRef: 'origin/epic/1143',
      headRef: 'story-1291',
      baselinePath: 'baselines/crap.json',
      readBaselineAtRef: () => {
        throw new Error('unresolvable ref');
      },
    });
    assert.deepEqual(rows, []);
  });
});

describe('diffCrapBaselines — pure comparator', () => {
  it('emits one row per regressed (file, method) and filters by touchedFiles', () => {
    const rows = diffCrapBaselines({
      baselineRows: fixture.baseline.rows,
      headRows: fixture.head.rows,
      touchedFiles: new Set(['lib/touched.js']),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].method, 'doWork');
    assert.equal(rows[0].drop, 6);
  });

  it('returns [] when touchedFiles is empty', () => {
    const rows = diffCrapBaselines({
      baselineRows: fixture.baseline.rows,
      headRows: fixture.head.rows,
      touchedFiles: new Set(),
    });
    assert.deepEqual(rows, []);
  });

  it('admits sibling regressions when touchedFiles is null (no filter)', () => {
    const rows = diffCrapBaselines({
      baselineRows: fixture.baseline.rows,
      headRows: fixture.head.rows,
      touchedFiles: null,
    });
    // Both doWork (8 → 14) and sibling::other (5 → 11) cross tolerance.
    const files = rows.map((r) => `${r.file}::${r.method}`).sort();
    assert.deepEqual(files, [
      'lib/sibling.js::other',
      'lib/touched.js::doWork',
    ]);
  });
});
