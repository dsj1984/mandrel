/**
 * Unit tests for the native ReviewProvider adapter.
 *
 * Story #2833 (Epic #2815) — verifies:
 *   - runReview returns Finding[] (never throws, never posts).
 *   - Severity ∈ {critical, high, medium, suggestion} only.
 *   - Empty diff → empty findings.
 *   - Lint errors produce a high-risk finding, warnings a suggestion,
 *     and executionFailed a suggestion (never a false-positive high).
 *   - Maintainability critical/warning tiers map to critical/medium
 *     findings, healthy tier is filtered out.
 *   - No GitHub provider methods are called from the adapter.
 *   - Invalid input shapes throw a TypeError.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeChangedFiles,
  buildLintFindings,
  classifyChangedFile,
  createNativeProvider,
  parseLintOutput,
  partitionFilesForLint,
  runScopedLint,
  SERIAL_THRESHOLD,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/native.js';

const ALLOWED_SEVERITIES = new Set([
  'critical',
  'high',
  'medium',
  'suggestion',
]);

function fakeDiff(stdout, status = 0) {
  return (_cwd, sub) => {
    if (sub === 'diff') return { status, stdout, stderr: '' };
    if (sub === 'rev-parse')
      return {
        status: 0,
        stdout: 'abcdef0123456789abcdef0123456789abcdef01\n',
        stderr: '',
      };
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('parseLintOutput: biome error + warning counts captured', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: 'Found 2 errors.\nFound 3 warnings.\n',
    stderr: '',
  });
  assert.deepEqual(out, {
    errors: 2,
    warnings: 3,
    parsed: true,
    executionFailed: false,
  });
});

test('parseLintOutput: unknown failing runner flags executionFailed', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: 'some unexpected output\n',
    stderr: 'boom\n',
  });
  assert.equal(out.executionFailed, true);
  assert.equal(out.errors, 0);
});

test('partitionFilesForLint: splits code and markdown, drops the rest', () => {
  const out = partitionFilesForLint([
    'a.js',
    'b.ts',
    'c.json',
    'd.md',
    'e.png',
    'f.css',
  ]);
  assert.deepEqual(out.code, ['a.js', 'b.ts', 'c.json']);
  assert.deepEqual(out.md, ['d.md']);
});

test('runScopedLint: empty changed surface skips both runners', () => {
  let calls = 0;
  const out = runScopedLint(['a.css', 'b.png'], '/cwd', () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '' };
  });
  assert.equal(calls, 0);
  assert.equal(out.skipped, true);
});

test('classifyChangedFile: critical tier yields a critical Finding with file attribution', () => {
  const out = classifyChangedFile('foo.js', {
    reportFn: () => ({ moduleScore: 5, worstMethod: 12 }),
    classifier: () => 'critical',
  });
  assert.equal(out.criticalFinding.severity, 'critical');
  assert.equal(out.criticalFinding.file, 'foo.js');
  assert.equal(out.criticalFinding.category, 'maintainability');
  assert.match(out.criticalFinding.body, /worst method 12.0/);
  assert.equal(out.mediumFinding, null);
});

test('classifyChangedFile: warning tier yields a medium Finding', () => {
  const out = classifyChangedFile('foo.js', {
    reportFn: () => ({ moduleScore: 60.5, worstMethod: 30.3 }),
    classifier: () => 'warning',
  });
  assert.equal(out.criticalFinding, null);
  assert.equal(out.mediumFinding.severity, 'medium');
  assert.match(out.mediumFinding.body, /worst method 30.3/);
});

test('classifyChangedFile: swallows file-deleted reportFn errors', () => {
  const out = classifyChangedFile('gone.js', {
    reportFn: () => {
      throw new Error('ENOENT');
    },
    classifier: () => 'healthy',
  });
  assert.deepEqual(out, {
    row: null,
    criticalFinding: null,
    mediumFinding: null,
  });
});

test('analyzeChangedFiles: only JS files contribute to maintainability counts', async () => {
  const tiers = new Map([
    [80, 'healthy'],
    [60, 'warning'],
    [10, 'critical'],
  ]);
  const reports = new Map([
    ['a.js', { moduleScore: 80, worstMethod: 50 }],
    ['b.mjs', { moduleScore: 60, worstMethod: 40 }],
    ['c.cjs', { moduleScore: 10, worstMethod: 5 }],
  ]);
  const out = await analyzeChangedFiles(
    ['a.js', 'b.mjs', 'c.cjs', 'd.md', 'e.txt'],
    {
      reportFn: (abs) => {
        const key = [...reports.keys()].find((k) => abs.endsWith(k));
        return reports.get(key);
      },
      classifier: (r) => tiers.get(r.moduleScore),
    },
  );
  assert.equal(out.totalFiles, 5);
  assert.equal(out.jsFiles, 3);
  assert.equal(out.criticalFindings.length, 1);
  assert.equal(out.mediumFindings.length, 1);
});

test('analyzeChangedFiles: serial and pooled paths produce identical rows and findings', async () => {
  // Acceptance: row / criticalFinding / mediumFinding parity between the
  // serial (in-process) and pooled (worker-pool) scoring paths on a fixed
  // fixture set. The fixture exceeds SERIAL_THRESHOLD so the pooled branch
  // is exercised, and mixes every tier so all finding buckets are populated.
  const reportByName = new Map([
    [
      'critical.js',
      { moduleScore: 5, worstMethod: 12, methods: [], parseError: false },
    ],
    [
      'warning.mjs',
      { moduleScore: 60, worstMethod: 30.5, methods: [], parseError: false },
    ],
    [
      'healthy.cjs',
      { moduleScore: 90, worstMethod: 80, methods: [], parseError: false },
    ],
    [
      'crit2.js',
      { moduleScore: 8, worstMethod: 10, methods: [], parseError: false },
    ],
    [
      'warn2.js',
      { moduleScore: 62, worstMethod: 40, methods: [], parseError: false },
    ],
    [
      'ok1.js',
      { moduleScore: 88, worstMethod: 70, methods: [], parseError: false },
    ],
    [
      'ok2.js',
      { moduleScore: 85, worstMethod: 72, methods: [], parseError: false },
    ],
    [
      'ok3.js',
      { moduleScore: 84, worstMethod: 71, methods: [], parseError: false },
    ],
  ]);
  const tierFor = (report) => {
    if (report.worstMethod !== null && report.worstMethod < 20)
      return 'critical';
    if (report.worstMethod !== null && report.worstMethod < 50)
      return 'warning';
    if (report.moduleScore < 65) return 'warning';
    return 'healthy';
  };
  const lookup = (abs) => {
    const key = [...reportByName.keys()].find((k) => abs.endsWith(k));
    return reportByName.get(key);
  };
  const changed = [...reportByName.keys(), 'README.md'];
  assert.ok(
    reportByName.size >= SERIAL_THRESHOLD,
    'fixture must reach SERIAL_THRESHOLD to force the pooled path',
  );

  // Serial path: caller injects its own reportFn (forces in-process scoring).
  const serial = await analyzeChangedFiles(changed, {
    reportFn: lookup,
    classifier: tierFor,
  });

  // Pooled path: omit reportFn (production scorer) and stub runOnPool to
  // return the same fixture reports in input order. The worker boundary is
  // the only difference, so any divergence is a parity bug.
  const jsFiles = changed.filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const pooled = await analyzeChangedFiles(changed, {
    classifier: tierFor,
    runOnPoolFn: async (_worker, absPaths) => {
      assert.equal(absPaths.length, jsFiles.length);
      return absPaths.map((abs) => ({ filePath: abs, report: lookup(abs) }));
    },
  });

  assert.deepEqual(pooled.maintainability, serial.maintainability);
  assert.deepEqual(pooled.criticalFindings, serial.criticalFindings);
  assert.deepEqual(pooled.mediumFindings, serial.mediumFindings);
  assert.equal(pooled.jsFiles, serial.jsFiles);
  assert.equal(pooled.totalFiles, serial.totalFiles);
});

test('analyzeChangedFiles: pooled path drops files with null report or pool error', async () => {
  const changed = Array.from({ length: 10 }, (_, i) => `f${i}.js`);
  const pooled = await analyzeChangedFiles(changed, {
    classifier: () => 'critical',
    runOnPoolFn: async (_worker, absPaths) =>
      absPaths.map((abs, i) => {
        if (i === 0) return { __cpuPoolError: true, message: 'crash' };
        if (i === 1) return { filePath: abs, report: null, error: 'ENOENT' };
        return {
          filePath: abs,
          report: {
            moduleScore: 5,
            worstMethod: 10,
            methods: [],
            parseError: false,
          },
        };
      }),
  });
  // 10 JS files, 2 dropped (pool error + null report) → 8 critical rows.
  assert.equal(pooled.jsFiles, 10);
  assert.equal(pooled.maintainability.length, 8);
  assert.equal(pooled.criticalFindings.length, 8);
});

test('buildLintFindings: errors collapse into a high-risk Finding', () => {
  const findings = buildLintFindings({
    errors: 3,
    warnings: 1,
    skipped: false,
    mode: 'changed-only',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].category, 'lint');
});

test('buildLintFindings: warnings-only collapses to a suggestion', () => {
  const findings = buildLintFindings({
    errors: 0,
    warnings: 4,
    skipped: false,
    mode: 'changed-only',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'suggestion');
});

test('buildLintFindings: executionFailed degrades to a suggestion (no false high-risk)', () => {
  const findings = buildLintFindings({
    errors: 0,
    warnings: 0,
    executionFailed: true,
    skipped: false,
    mode: 'changed-only',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'suggestion');
  assert.match(findings[0].title, /could not execute/);
});

test('buildLintFindings: scope-off / skipped / evidence-skipped emit no findings', () => {
  assert.deepEqual(buildLintFindings({ mode: 'off' }), []);
  assert.deepEqual(
    buildLintFindings({ skipped: true, mode: 'changed-only' }),
    [],
  );
  assert.deepEqual(
    buildLintFindings({ evidenceSkipped: true, mode: 'changed-only' }),
    [],
  );
});

test('runReview: empty diff returns []', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff(''),
    runScopedLintFn: () => {
      throw new Error('must not run lint when diff is empty');
    },
    analyzeChangedFilesFn: () => {
      throw new Error('must not analyze when diff is empty');
    },
  });
  const findings = await provider.runReview({
    scope: 'epic',
    ticketId: 42,
    baseRef: 'main',
    headRef: 'epic/42',
  });
  assert.deepEqual(findings, []);
});

test('runReview: returns Finding[] with severities in the canonical set for a mixed diff', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('a.js\nb.js\nREADME.md\n'),
    runScopedLintFn: () => ({
      errors: 2,
      warnings: 1,
      skipped: false,
      mode: 'changed-only',
    }),
    analyzeChangedFilesFn: () => ({
      totalFiles: 3,
      jsFiles: 2,
      maintainability: [],
      criticalFindings: [
        {
          severity: 'critical',
          title: 'Low Maintainability',
          body: 'crit',
          file: 'a.js',
          category: 'maintainability',
        },
      ],
      mediumFindings: [
        {
          severity: 'medium',
          title: 'Size/Volume Warning',
          body: 'warn',
          file: 'b.js',
          category: 'maintainability',
        },
      ],
    }),
    shouldSkipFn: () => ({ skip: false }),
    recordPassFn: () => {},
  });

  const findings = await provider.runReview({
    scope: 'epic',
    ticketId: 42,
    baseRef: 'main',
    headRef: 'epic/42',
  });

  assert.ok(Array.isArray(findings));
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(
      ALLOWED_SEVERITIES.has(f.severity),
      `severity "${f.severity}" must be in the canonical set`,
    );
    assert.equal(typeof f.title, 'string');
    assert.equal(typeof f.body, 'string');
  }
  // Canonical ordering: critical → high → medium → suggestion. With
  // lint errors > 0 the suggestion bucket collapses into high (warnings
  // are folded into the same finding), so the expected shape is
  // [critical, high, medium].
  const severities = findings.map((f) => f.severity);
  assert.deepEqual(severities, ['critical', 'high', 'medium']);
});

test('runReview: never invokes a GitHub provider method', async () => {
  // The adapter does not receive a GitHub provider at all — verifying the
  // shape contract: createNativeProvider takes no provider, and runReview
  // returns Finding[] without any external posting.
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('a.js\n'),
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      skipped: false,
      mode: 'changed-only',
    }),
    analyzeChangedFilesFn: () => ({
      totalFiles: 1,
      jsFiles: 1,
      maintainability: [],
      criticalFindings: [],
      mediumFindings: [],
    }),
    shouldSkipFn: () => ({ skip: false }),
    recordPassFn: () => {},
  });
  const findings = await provider.runReview({
    scope: 'epic',
    ticketId: 1,
    baseRef: 'main',
    headRef: 'epic/1',
  });
  assert.ok(Array.isArray(findings));
});

test('runReview: failed git diff throws (the orchestrator owns the envelope)', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: bad ref',
    }),
  });
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 42,
        baseRef: 'main',
        headRef: 'epic/42',
      }),
    /Failed to get diff/,
  );
});

test('runReview: rejects invalid input shapes with TypeError', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 0,
        baseRef: 'main',
        headRef: 'epic/0',
      }),
    TypeError,
  );
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 42,
        baseRef: '',
        headRef: 'epic/42',
      }),
    TypeError,
  );
});
