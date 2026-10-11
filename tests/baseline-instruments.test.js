// tests/baseline-instruments.test.js
//
// Story #4923 — repo invariants over the committed baseline surface.
//
// The Story's finding was that most of that surface could not fail: four
// zero-row all-zero-rollup baselines that had read green since 2026-05-15, a
// duplication baseline whose rows named deleted files, a maintainability
// baseline that skipped 47 in-scope files, and two `ignoreGlobs` entries
// matching nothing. Every one of those is a state a future commit can
// re-enter silently, so each gets an assertion here rather than a one-time
// cleanup.
//
// The checks deliberately drive the repository's OWN measurement helpers —
// `buildGateSurface` for stub detection and dead globs, `scanDirectory` for
// the maintainability walk — so a change to what the engine considers a stub
// moves this test with it instead of leaving two definitions to drift.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { buildGateSurface } from '../.agents/scripts/lib/audit-baselines/gate-surface.js';
import { rollupOfRows } from '../.agents/scripts/lib/audit-baselines/rollup.js';
import { load } from '../.agents/scripts/lib/baselines/reader.js';
import {
  getQuality,
  resolveConfig,
} from '../.agents/scripts/lib/config-resolver.js';
import { scanDirectory } from '../.agents/scripts/lib/maintainability-utils.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const quality = getQuality(resolveConfig({ cwd: REPO_ROOT }));
const { entries: surface } = buildGateSurface({ cwd: REPO_ROOT, quality });

describe('no committed baseline is a placeholder instrument', () => {
  test('no zero-row all-zero-rollup baseline remains', () => {
    const stubs = surface.filter((entry) => entry.stub);
    assert.deepEqual(
      stubs.map((s) => s.baselinePath),
      [],
      'a baseline with zero rows and an all-zero rollup passes vacuously — ' +
        'the surface it names looks governed while nothing measures it. ' +
        'Give it a producer that writes real rows, or delete it.',
    );
  });

  test('every baseline present on disk parses', () => {
    const broken = surface.filter((e) => e.baselineExists && e.parseError);
    assert.deepEqual(
      broken.map((e) => e.baselinePath),
      [],
    );
  });

  test('every configured gate has a committed baseline', () => {
    const missing = surface.filter((e) => e.configured && !e.baselineExists);
    assert.deepEqual(
      missing.map((e) => e.kind),
      [],
      'a configured gate with no baseline artifact is skipped by ' +
        'close-validation, which reads as a pass',
    );
  });
});

describe('no gate ignoreGlob is dead weight', () => {
  test('every ignoreGlobs entry matches at least one tracked file', () => {
    const dead = surface
      .filter((entry) => entry.deadIgnoreGlobs.length > 0)
      .map((entry) => `${entry.kind}: ${entry.deadIgnoreGlobs.join(', ')}`);
    assert.deepEqual(
      dead,
      [],
      'an ignoreGlob matching zero files is an exemption for code that no ' +
        'longer exists — it survives only because nothing audits it',
    );
  });
});

describe('baselines/duplication.json is a live measurement', () => {
  const baseline = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'baselines', 'duplication.json'),
      'utf8',
    ),
  );

  test('no row names a path absent from the tree', () => {
    const ghosts = baseline.rows
      .map((r) => r.path)
      .filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
    assert.deepEqual(
      ghosts,
      [],
      `${ghosts.length} duplication rows name files that no longer exist. A ` +
        'row compared against a deleted file is byte-identical to itself ' +
        'forever; re-run `npm run duplication:update`.',
    );
  });

  test('the file carries no rollup that could disagree with its rows', () => {
    // Story #5400: the rollup the floor is checked against is derived from the
    // rows on read, so a committed copy could only ever go stale.
    assert.equal(Object.hasOwn(baseline, 'rollup'), false);
    assert.equal(
      rollupOfRows('duplication', baseline.rows).filesWithDuplication,
      baseline.rows.length,
    );
  });
});

describe('baselines/maintainability.json covers the declared scope', () => {
  const baseline = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'baselines', 'maintainability.json'),
      'utf8',
    ),
  );
  const rowPaths = new Set(baseline.rows.map((r) => r.path));

  /** The exact walk the full-scope refresh performs. */
  const inScope = (() => {
    const mi = quality.maintainability;
    const files = [];
    for (const dir of mi.targetDirs) {
      scanDirectory(path.resolve(REPO_ROOT, dir), files, {
        cwd: REPO_ROOT,
        ignoreGlobs: mi.ignoreGlobs ?? [],
      });
    }
    return files
      .map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'))
      .sort();
  })();

  test('every non-test source file under targetDirs has a row', () => {
    const missing = inScope.filter((f) => !rowPaths.has(f));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} in-scope source files have no maintainability row, ` +
        'so they have no floor and nothing to regress against. Re-run ' +
        '`npm run maintainability:update -- --full-scope`.',
    );
  });

  test('the repository highest-churn file is scored', () => {
    // Named explicitly because it was the headline omission: the file most
    // likely to regress was the one with no row.
    assert.ok(
      rowPaths.has('.agents/scripts/lib/orchestration/plan-context.js'),
      'plan-context.js must carry a maintainability row',
    );
  });

  test('no row names a path absent from the tree', () => {
    const ghosts = [...rowPaths].filter(
      (p) => !fs.existsSync(path.join(REPO_ROOT, p)),
    );
    assert.deepEqual(ghosts, []);
  });
});

describe('the committed floors are tightened to the measured levels', () => {
  // The committed files carry no rollup (Story #5400); derive the one the
  // floors gate compares against from the rows the reader loads.
  const readRollup = (kind) =>
    rollupOfRows(kind, load(kind, { cwd: REPO_ROOT }).rows);

  test('the crap methodsAbove20 floor is at the measured count', () => {
    assert.equal(
      quality.gates.crap.floors['*'].methodsAbove20,
      readRollup('crap').methodsAbove20,
      'slack between the floor and the measurement is silently re-spent',
    );
  });

  test('the maintainability min floor sits at the measured minimum', () => {
    const measured = readRollup('maintainability').min;
    const floor = quality.gates.maintainability.floors['*'].min;
    assert.ok(
      floor <= measured && measured - floor < 1,
      `maintainability min floor ${floor} should sit within 1 point below the ` +
        `measured ${measured}; the floor's granularity is whole points`,
    );
  });

  test('the duplication floor sits at the measured rollup', () => {
    // Story #4962 held this floor more than the tolerance above the
    // measurement while the baseline had no automated writer. Story #5626
    // gave it one (close re-scores changed files untagged; the nightly drift
    // job re-anchors the rest), so the floor now sits at the measurement like
    // CRAP's: any net rise in duplicated lines breaches it. The floor phase
    // compares `value <= floor` with no tolerance, so equality is satisfiable.
    const floor = quality.gates.duplication.floors['*'].percentage;
    const measured = readRollup('duplication').percentage;
    assert.ok(
      measured <= floor,
      `duplication floor ${floor} is below the measured ${measured} — the ` +
        'committed tree already breaches it',
    );
    assert.ok(
      floor - measured < 1,
      `duplication floor ${floor} leaves ${(floor - measured).toFixed(2)}pt of ` +
        'unclaimed slack above the measured value — tighten it',
    );
  });
});

describe('the tracked baselines directory holds no orphans', () => {
  test('every committed baselines/*.json is a kind the engine walks', () => {
    const tracked = execFileSync('git', ['ls-files', 'baselines'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((p) => p.endsWith('.json'));
    const known = new Set(surface.map((e) => e.baselinePath));
    const orphans = tracked.filter((p) => !known.has(p));
    assert.deepEqual(
      orphans,
      [],
      'a baseline file no engine reads is an instrument nobody can act on',
    );
  });
});
