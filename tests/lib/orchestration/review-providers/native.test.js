/**
 * Unit tests for the native ReviewProvider adapter.
 *
 * Story #2833 (Epic #2815) — verifies:
 *   - runReview returns Finding[] (never throws, never posts).
 *   - Severity ∈ {critical, high, medium, suggestion} only.
 *   - Empty diff → empty findings.
 *   - Lint errors produce a high-risk finding, warnings a suggestion,
 *     and executionFailed ZERO findings — the degradation is routed to
 *     friction telemetry instead (Story #4699).
 *   - Maintainability critical/warning tiers map to critical/medium
 *     findings, healthy tier is filtered out.
 *   - No GitHub provider methods are called from the adapter.
 *   - Invalid input shapes throw a TypeError.
 *
 * Story #4839 — adds the reproduction + regression set for the defect that made
 * this gate fail open on ~78% of deliveries: the markdown runner was spawned
 * under a bin name nothing installs, one runner's failure was folded into the
 * other's verdict, and biome's empty-scope exit was read as a broken runner.
 * Plus the visibility contract: a degraded gate is reported on the review
 * outcome (provider channel + rendered comment) while still emitting zero
 * findings, so #4699's severity-tier intent survives.
 *
 * Story #5282 — narrows that last clause to what it always meant. Findings are
 * emitted from the parsed counts, not from `executionFailed`, which is the OR
 * across surfaces: an absent biome (the default checkout since #5193) was
 * discarding markdownlint's real errors. A degraded surface still contributes
 * no counts and no finding, and the merged summary now carries per-surface
 * `parsed` so a zero from an absent runner is distinguishable from a zero from
 * a runner that ran.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFindings } from '../../../../.agents/scripts/lib/orchestration/review-providers/findings-renderer.js';
import {
  analyzeChangedFiles,
  buildLintFindings,
  classifyChangedFile,
  createNativeProvider,
  parseLintOutput,
  partitionFilesForLint,
  readHeadSource,
  runScopedLint,
  SERIAL_THRESHOLD,
  scoreSourceReport,
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
    if (sub === 'show')
      return { status: 0, stdout: 'const x = 1;', stderr: '' };
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
    emptyScope: false,
    reason: null,
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
  // Map each path to its head source string; the injected reportFn keys off
  // the source it receives (Story #3696: scoring is head-source-based).
  const reportBySource = new Map([
    ['src:a.js', { moduleScore: 80, worstMethod: 50 }],
    ['src:b.mjs', { moduleScore: 60, worstMethod: 40 }],
    ['src:c.cjs', { moduleScore: 10, worstMethod: 5 }],
  ]);
  const out = await analyzeChangedFiles(
    ['a.js', 'b.mjs', 'c.cjs', 'd.md', 'e.txt'],
    {
      headRef: 'story-1',
      readHeadSourceFn: (relPath) => `src:${relPath}`,
      reportFn: (source) => reportBySource.get(source),
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
  // fixture set. The pooled branch is selected by the `serialThreshold` seam
  // rather than by out-sizing the cutover — Story #5109 raised
  // SERIAL_THRESHOLD to 256 and a size-based fixture would have silently
  // stopped exercising the pool. The fixture mixes every tier so all finding
  // buckets are populated.
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
  // Story #3696: both paths score the head source string. The injected
  // readHeadSourceFn maps each path to a `src:<name>` sentinel; the lookup
  // keys off that sentinel so serial and pooled use identical reports.
  const readHeadSourceFn = (relPath) => `src:${relPath}`;
  const lookup = (source) => {
    const key = [...reportByName.keys()].find((k) => source.endsWith(k));
    return reportByName.get(key);
  };
  const changed = [...reportByName.keys(), 'README.md'];
  // `1` means "never take the serial path", whatever SERIAL_THRESHOLD is.
  const FORCE_POOL = 1;
  assert.ok(
    SERIAL_THRESHOLD > FORCE_POOL,
    'the seam must actually lower the cutover for this call',
  );

  // Serial path: caller injects its own reportFn (forces in-process scoring).
  const serial = await analyzeChangedFiles(changed, {
    headRef: 'story-1',
    readHeadSourceFn,
    reportFn: lookup,
    classifier: tierFor,
  });

  // Pooled path: omit reportFn (production scorer) and stub runOnPool to
  // return the same fixture reports in input order. The worker boundary is
  // the only difference, so any divergence is a parity bug. The pool now
  // receives pre-sourced `{ source, label }` items (Story #3696).
  const jsFiles = changed.filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const pooled = await analyzeChangedFiles(changed, {
    headRef: 'story-1',
    readHeadSourceFn,
    classifier: tierFor,
    serialThreshold: FORCE_POOL,
    runOnPoolFn: async (_worker, poolItems) => {
      assert.equal(poolItems.length, jsFiles.length);
      return poolItems.map((item) => ({
        filePath: item.label,
        report: lookup(item.source),
      }));
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
    headRef: 'story-1',
    readHeadSourceFn: (relPath) => `src:${relPath}`,
    classifier: () => 'critical',
    serialThreshold: 1,
    runOnPoolFn: async (_worker, poolItems) =>
      poolItems.map((item, i) => {
        if (i === 0) return { __cpuPoolError: true, message: 'crash' };
        if (i === 1)
          return { filePath: item.label, report: null, error: 'ENOENT' };
        return {
          filePath: item.label,
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

test('buildLintFindings: a degradation with nothing parsed emits zero findings (routed to friction telemetry, Story #4699)', () => {
  const findings = buildLintFindings({
    errors: 0,
    warnings: 0,
    parsed: false,
    executionFailed: true,
    skipped: false,
    mode: 'changed-only',
  });
  assert.deepEqual(
    findings,
    [],
    'a tool-execution degradation is not a code finding',
  );
});

test('buildLintFindings: an unparsed summary emits nothing even if it carries counts (Story #5282)', () => {
  assert.deepEqual(
    buildLintFindings({
      errors: 7,
      warnings: 2,
      parsed: false,
      executionFailed: false,
      skipped: false,
      mode: 'changed-only',
    }),
    [],
    'counts that no surface parsed are not evidence of anything',
  );
});

test('buildLintFindings: parsed counts survive a sibling surface degrading (Story #5282)', () => {
  // The merged shape `runScopedLint` returns when markdownlint parsed 3 errors
  // and biome never resolved: `executionFailed` is the OR, so gating findings
  // on it discarded the markdown errors entirely.
  const findings = buildLintFindings({
    errors: 3,
    warnings: 0,
    parsed: true,
    executionFailed: true,
    skipped: false,
    mode: 'changed-only',
    degradations: [{ surface: 'biome', reason: 'runner-not-installed' }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].title, /3 error\(s\)/);
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

// ---------------------------------------------------------------------------
// Story #3696 — the native review scores the HEAD version of each changed
// file, not the on-disk (base) copy. An MI-improving change must NOT emit a
// false-positive size/volume warning citing the debt it removes.
// ---------------------------------------------------------------------------

test('readHeadSource: sources `git show <headRef>:<path>` content', () => {
  const calls = [];
  const gitSpawnFn = (_cwd, ...args) => {
    calls.push(args);
    return { status: 0, stdout: 'export const answer = 42;', stderr: '' };
  };
  const source = readHeadSource('src/foo.js', 'story-99', gitSpawnFn);
  assert.equal(source, 'export const answer = 42;');
  assert.deepEqual(calls, [['show', 'story-99:src/foo.js']]);
});

test('readHeadSource: returns null when the file does not exist at head', () => {
  const gitSpawnFn = () => ({
    status: 128,
    stdout: '',
    stderr: "fatal: path 'gone.js' does not exist in 'story-99'",
  });
  assert.equal(readHeadSource('gone.js', 'story-99', gitSpawnFn), null);
});

test('scoreSourceReport: scores a healthy source string as healthy-tier', () => {
  // A short, well-structured module scores well above the warning floor.
  const report = scoreSourceReport(
    'export function add(a, b) {\n  return a + b;\n}\n',
    'add.js',
  );
  assert.equal(report.parseError, false);
  assert.ok(report.moduleScore >= 65, `moduleScore=${report.moduleScore}`);
});

test('analyzeChangedFiles: scores head content, not the on-disk base copy', async () => {
  // The diff names a file whose on-disk (base) copy would be a monolith; the
  // head copy sourced via git is small and healthy. Scoring must reflect head.
  const headSource = 'export const ok = () => 1;\n';
  let showRef = null;
  const gitSpawnFn = (_cwd, sub, refPath) => {
    if (sub === 'show') {
      showRef = refPath;
      return { status: 0, stdout: headSource, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = await analyzeChangedFiles(['big.js'], {
    headRef: 'story-3696',
    gitSpawnFn,
  });
  // It sourced from the head ref, not from PROJECT_ROOT on disk.
  assert.equal(showRef, 'story-3696:big.js');
  // Head is healthy → no critical, no medium warning.
  assert.equal(out.jsFiles, 1);
  assert.equal(out.criticalFindings.length, 0);
  assert.equal(out.mediumFindings.length, 0);
  assert.equal(out.maintainability[0].tier, 'healthy');
});

test('analyzeChangedFiles: drops a file deleted at head (null head source)', async () => {
  const gitSpawnFn = (_cwd, sub) => {
    if (sub === 'show')
      return { status: 128, stdout: '', stderr: 'does not exist' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = await analyzeChangedFiles(['deleted.js'], {
    headRef: 'story-3696',
    gitSpawnFn,
  });
  assert.equal(out.jsFiles, 1);
  assert.equal(out.maintainability.length, 0);
  assert.equal(out.criticalFindings.length, 0);
  assert.equal(out.mediumFindings.length, 0);
});

test('runReview: MI-improving change emits no size/volume warning (head MI healthy)', async () => {
  // Regression for Story #3696 / PR #3692: a refactor that improves MI from a
  // below-threshold monolith to a healthy head must produce NO medium
  // size/volume finding. The base copy would warn; the head copy is healthy.
  const healthyHead = 'export const noop = () => undefined;\n';
  const gitSpawnFn = (_cwd, sub, arg) => {
    if (sub === 'diff')
      return { status: 0, stdout: 'refactored.js\n', stderr: '' };
    if (sub === 'rev-parse')
      return {
        status: 0,
        stdout: 'abcdef0123456789abcdef0123456789abcdef01',
        stderr: '',
      };
    if (sub === 'show') {
      assert.equal(arg, 'story-3696:refactored.js');
      return { status: 0, stdout: healthyHead, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const provider = createNativeProvider({
    gitSpawnFn,
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      skipped: false,
      mode: 'changed-only',
    }),
    shouldSkipFn: () => ({ skip: false }),
    recordPassFn: () => {},
  });

  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 3696,
    baseRef: 'main',
    headRef: 'story-3696',
  });

  const sizeVolume = findings.filter((f) => f.title === 'Size/Volume Warning');
  assert.equal(
    sizeVolume.length,
    0,
    'an MI-improving change must not emit a size/volume warning for a healthy head file',
  );
});

test('runReview: a lint runner that cannot execute records friction telemetry and zero lint findings (Story #4699)', async () => {
  const frictionCalls = [];
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('README.md\n'),
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      parsed: false,
      executionFailed: true,
      skipped: false,
      mode: 'changed-only',
    }),
    analyzeChangedFilesFn: async () => ({
      totalFiles: 1,
      jsFiles: 0,
      maintainability: [],
      criticalFindings: [],
      mediumFindings: [],
    }),
    emitToolDegradationFn: async (args) => {
      frictionCalls.push(args);
      return true;
    },
  });

  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 4699,
    baseRef: 'main',
    headRef: 'story-4699',
  });

  assert.deepEqual(
    findings,
    [],
    'a tool-execution degradation must not appear in the findings tiers',
  );
  assert.equal(frictionCalls.length, 1, 'friction telemetry is recorded');
  assert.equal(frictionCalls[0].storyId, 4699);
  assert.equal(frictionCalls[0].category, 'tool-degraded');
  assert.equal(frictionCalls[0].tool, 'native-review-lint');
});

/* ------------------------------------------------------------------------ */
/* Story #4839 — why the runner could not execute, and why nobody noticed   */
/* ------------------------------------------------------------------------ */

/**
 * A `node_modules/.bin` probe that reports only the named bins as installed.
 *
 * The comparison is on the path's last segment, split on **either** separator:
 * `resolveMarkdownRunner` builds its probe path with `path.join`, so on Windows
 * the double receives `node_modules\.bin\markdownlint-cli2`. A `/`-only match
 * silently reported every bin as missing there, which made these tests fail on
 * the Windows leg alone while passing on POSIX.
 */
function binsInstalled(...names) {
  return (probePath) => names.includes(probePath.split(/[\\/]/).pop());
}

/** Record every `(bin, args)` the scoped-lint gate spawns. */
function recordingRunner(byBin) {
  const calls = [];
  const runner = (bin, args) => {
    calls.push({ bin, args });
    return byBin[bin] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { calls, runner };
}

test('runScopedLint: resolves the installed markdownlint-cli2 bin, never the bare `markdownlint` name (Story #4839 root cause)', () => {
  const { calls, runner } = recordingRunner({
    'markdownlint-cli2': {
      status: 0,
      stdout: 'Finding: README.md\nLinting: 1 file(s)\nSummary: 0 error(s)\n',
      stderr: '',
    },
  });

  const out = runScopedLint(['README.md'], '/repo', runner, {
    existsFn: binsInstalled('markdownlint-cli2', 'biome'),
  });

  assert.deepEqual(
    calls.map((c) => c.bin),
    ['markdownlint-cli2'],
    'the gate must spawn the bin that is actually installed',
  );
  assert.equal(
    calls[0].args.includes('--ignore'),
    false,
    'markdownlint-cli2 rejects the cli-v1 --ignore flag; it must not be passed',
  );
  assert.equal(
    out.executionFailed,
    false,
    'a resolvable runner whose Summary line parses is not a degraded gate',
  );
  assert.deepEqual(out.degradations, []);
});

test('runScopedLint: an unresolvable markdown runner degrades that surface by name instead of failing open', () => {
  const { calls, runner } = recordingRunner({});

  const out = runScopedLint(['README.md'], '/repo', runner, {
    existsFn: binsInstalled('biome'),
  });

  assert.equal(
    calls.length,
    0,
    'no markdown runner is spawned when none exists',
  );
  assert.equal(out.executionFailed, true);
  assert.deepEqual(out.degradations, [
    { surface: 'markdownlint', reason: 'runner-not-installed' },
  ]);
});

test('runScopedLint: a degraded markdown surface no longer poisons the biome verdict (Story #4839)', () => {
  const { runner } = recordingRunner({
    biome: { status: 1, stdout: 'Found 3 errors.\n', stderr: '' },
  });

  const out = runScopedLint(['a.js', 'README.md'], '/repo', runner, {
    existsFn: binsInstalled('biome'),
  });

  assert.equal(
    out.errors,
    3,
    "biome's real error count must survive a sibling runner's failure",
  );
  assert.deepEqual(
    out.degradations.map((d) => d.surface),
    ['markdownlint'],
    'only the surface that could not run is reported degraded',
  );
});

test('runScopedLint: a clean biome run plus a working markdown runner is not degraded (the pre-fix false positive)', () => {
  const { runner } = recordingRunner({
    biome: {
      status: 0,
      stdout: 'Checked 1 file in 4ms. No fixes applied.\n',
      stderr: '',
    },
    'markdownlint-cli2': {
      status: 0,
      stdout: 'Summary: 0 error(s)\n',
      stderr: '',
    },
  });

  const out = runScopedLint(['a.js', 'README.md'], '/repo', runner, {
    existsFn: binsInstalled('markdownlint-cli2', 'biome'),
  });

  assert.equal(out.executionFailed, false);
  assert.equal(out.errors, 0);
  assert.deepEqual(out.degradations, []);
});

test("parseLintOutput: biome's empty-scope exit is not an execution failure (Story #4839)", () => {
  const out = parseLintOutput({
    status: 1,
    stdout: 'Checked 0 files in 484µs. No fixes applied.\n',
    stderr:
      '  × No files were processed in the specified paths.\n  i Check your biome.json\n',
  });

  assert.equal(
    out.executionFailed,
    false,
    'every supplied path being config-ignored is an empty scope, not a broken runner',
  );
  assert.equal(out.emptyScope, true);
});

test('parseLintOutput: an unresolvable npx bin is reported as runner-not-resolvable', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: '',
    stderr: 'npm error could not determine executable to run\n',
  });

  assert.equal(out.executionFailed, true);
  assert.equal(out.reason, 'runner-not-resolvable');
});

test('runScopedLint: an absent code runner degrades by name instead of reading clean (Story #5193)', () => {
  const { calls, runner } = recordingRunner({});

  const out = runScopedLint(['a.js', 'b.mjs'], '/repo', runner, {
    existsFn: binsInstalled('markdownlint-cli2'),
  });

  assert.equal(
    calls.length,
    0,
    'a runner that did not resolve must never be spawned',
  );
  assert.equal(out.executionFailed, true);
  assert.deepEqual(out.degradations, [
    { surface: 'biome', reason: 'runner-not-installed' },
  ]);
});

test('runScopedLint: a zero-exit empty-output spawn can no longer read as a clean code surface (Story #5193 root cause)', () => {
  // Exactly what `npx --no biome lint <file>` does on npm 11.x when biome is
  // absent: exit 0, no output. Pre-fix this merged as errors:0 / warnings:0
  // with an empty degradations[] — indistinguishable from a genuine clean.
  const { runner } = recordingRunner({
    biome: { status: 0, stdout: '', stderr: '' },
  });

  const out = runScopedLint(['a.js'], '/repo', runner, {
    existsFn: binsInstalled(),
  });

  assert.equal(out.errors, 0);
  assert.equal(out.warnings, 0);
  assert.notDeepEqual(
    out.degradations,
    [],
    'a surface whose runner never resolved must declare itself, not report clean',
  );
  assert.equal(out.executionFailed, true);
});

test('runScopedLint: an installed code runner still lints and reports its counts (Story #5193 regression guard)', () => {
  const { calls, runner } = recordingRunner({
    biome: { status: 1, stdout: 'Found 2 error(s).\n', stderr: '' },
  });

  const out = runScopedLint(['a.js'], '/repo', runner, {
    existsFn: binsInstalled('biome'),
  });

  assert.deepEqual(calls, [{ bin: 'biome', args: ['lint', 'a.js'] }]);
  assert.equal(out.errors, 2);
  assert.equal(out.parsed, true);
  assert.equal(out.executionFailed, false);
  assert.deepEqual(out.degradations, []);
});

test('scoped lint + findings: an absent biome no longer discards markdownlint errors (Story #5282, AC-1)', () => {
  // The default state of a consumer checkout since the #5193 disk probe: no
  // `node_modules/.bin/biome`, a working markdownlint, real markdown errors.
  const { runner } = recordingRunner({
    'markdownlint-cli2': {
      status: 1,
      stdout: 'Linting: 1 file(s)\nSummary: 3 error(s)\n',
      stderr: '',
    },
  });

  const out = runScopedLint(['a.js', 'README.md'], '/repo', runner, {
    existsFn: binsInstalled('markdownlint-cli2'),
  });

  assert.equal(out.errors, 3, 'the surface that ran still contributes counts');
  assert.equal(out.parsed, true);
  assert.equal(out.executionFailed, true, 'the absent surface still degrades');
  assert.deepEqual(
    out.degradations,
    [{ surface: 'biome', reason: 'runner-not-installed' }],
    'the degradation is carried unchanged and still named',
  );

  const findings = buildLintFindings(out);
  assert.equal(findings.length, 1, 'the real markdown errors reach the review');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].title, /3 error\(s\)/);
});

test('scoped lint + findings: both surfaces absent yields no findings and two degradations (Story #5282, AC-2)', () => {
  const { calls, runner } = recordingRunner({});

  const out = runScopedLint(['a.js', 'README.md'], '/repo', runner, {
    existsFn: binsInstalled(),
  });

  assert.equal(calls.length, 0, 'no runner resolved, so none is spawned');
  assert.equal(out.parsed, false);
  assert.deepEqual(out.degradations, [
    { surface: 'biome', reason: 'runner-not-installed' },
    { surface: 'markdownlint', reason: 'runner-not-installed' },
  ]);
  assert.deepEqual(
    buildLintFindings(out),
    [],
    'nothing ran, so there is nothing to report as a finding',
  );
});

test('runScopedLint: per-surface `parsed` distinguishes an absent biome from a silent one (Story #5282, AC-3)', () => {
  const { runner: absentRunner } = recordingRunner({});
  const absent = runScopedLint(['a.js'], '/repo', absentRunner, {
    existsFn: binsInstalled(),
  });

  const { runner: cleanRunner } = recordingRunner({
    biome: { status: 0, stdout: 'Found 0 error(s).\n', stderr: '' },
  });
  const clean = runScopedLint(['a.js'], '/repo', cleanRunner, {
    existsFn: binsInstalled('biome'),
  });

  // Both merge to errors: 0. Only the per-surface rows say which zero it is.
  assert.equal(absent.errors, 0);
  assert.equal(clean.errors, 0);
  assert.deepEqual(absent.surfaces, [
    {
      surface: 'biome',
      parsed: false,
      errors: 0,
      warnings: 0,
      executionFailed: true,
    },
  ]);
  assert.deepEqual(clean.surfaces, [
    {
      surface: 'biome',
      parsed: true,
      errors: 0,
      warnings: 0,
      executionFailed: false,
    },
  ]);
});

test('runScopedLint: per-surface rows attribute the merged counts to their surface (Story #5282, AC-3)', () => {
  const { runner } = recordingRunner({
    biome: { status: 1, stdout: 'Found 2 error(s).\n', stderr: '' },
    'markdownlint-cli2': {
      status: 1,
      stdout: 'Summary: 5 error(s)\n',
      stderr: '',
    },
  });

  const out = runScopedLint(['a.js', 'README.md'], '/repo', runner, {
    existsFn: binsInstalled('biome', 'markdownlint-cli2'),
  });

  assert.equal(out.errors, 7, 'the flat counts still add across surfaces');
  assert.deepEqual(
    out.surfaces.map((row) => [row.surface, row.errors, row.parsed]),
    [
      ['biome', 2, true],
      ['markdownlint-cli2', 5, true],
    ],
  );
});

test('runScopedLint: a skipped gate reports no surface rows (Story #5282)', () => {
  const out = runScopedLint(['a.css'], '/repo', () => {
    throw new Error('must not spawn a runner for an empty lint surface');
  });
  assert.equal(out.skipped, true);
  assert.deepEqual(out.surfaces, []);
});

test("parseLintOutput: npm's current E404 answer is runner-not-resolvable, not unparseable-output (Story #5193)", () => {
  const out = parseLintOutput({
    status: 1,
    stdout: '',
    stderr:
      'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope\n',
  });

  assert.equal(out.executionFailed, true);
  assert.equal(
    out.reason,
    'runner-not-resolvable',
    'the reason code is the whole point of the degradation record',
  );
});

test('parseLintOutput: a non-E404 npm failure stays unparseable-output (the sentinel is not a blanket npm matcher)', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: '',
    stderr: 'npm error code ELIFECYCLE\nnpm error errno 1\n',
  });

  assert.equal(out.executionFailed, true);
  assert.equal(out.reason, 'unparseable-output');
});

test('runScopedLint: falls back to markdownlint (cli v1) with its own --ignore arg shape', () => {
  const { calls, runner } = recordingRunner({
    markdownlint: { status: 0, stdout: 'Summary: 0 error(s)\n', stderr: '' },
  });

  const out = runScopedLint(['docs/a.md'], '/repo', runner, {
    existsFn: binsInstalled('markdownlint'),
  });

  assert.deepEqual(calls, [
    { bin: 'markdownlint', args: ['docs/a.md', '--ignore', 'node_modules'] },
  ]);
  assert.equal(out.executionFailed, false);
});

test('runReview: a degraded lint gate is visible on the outcome channel while emitting zero findings (Story #4839 AC-2/AC-3/AC-4)', async () => {
  const frictionCalls = [];
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('README.md\n'),
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      parsed: false,
      executionFailed: true,
      skipped: false,
      mode: 'changed-only',
      degradations: [
        { surface: 'markdownlint', reason: 'runner-not-installed' },
      ],
    }),
    analyzeChangedFilesFn: async () => ({
      totalFiles: 1,
      jsFiles: 0,
      maintainability: [],
      criticalFindings: [],
      mediumFindings: [],
    }),
    emitToolDegradationFn: async (args) => {
      frictionCalls.push(args);
      return true;
    },
  });

  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 4839,
    baseRef: 'main',
    headRef: 'story-4839',
  });

  // AC-3: no severity tier gains a row — the degradation is not a finding.
  assert.deepEqual(findings, []);
  // AC-4: the friction emission is unchanged.
  assert.equal(frictionCalls.length, 1);
  assert.equal(frictionCalls[0].category, 'tool-degraded');
  assert.equal(frictionCalls[0].tool, 'native-review-lint');
  // AC-2: and the outcome now says the gate did not run.
  assert.deepEqual(provider.getDegradations(), [
    {
      tool: 'native-review-lint',
      gate: 'scoped-lint',
      surface: 'markdownlint',
      reason: 'runner-not-installed',
    },
  ]);
});

test('runReview: a legacy summary carrying only executionFailed still degrades the outcome, never silently', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('README.md\n'),
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      parsed: false,
      executionFailed: true,
      skipped: false,
      mode: 'changed-only',
    }),
    analyzeChangedFilesFn: async () => ({
      totalFiles: 1,
      jsFiles: 0,
      maintainability: [],
      criticalFindings: [],
      mediumFindings: [],
    }),
    emitToolDegradationFn: async () => true,
  });

  await provider.runReview({
    scope: 'story',
    ticketId: 4839,
    baseRef: 'main',
    headRef: 'story-4839',
  });

  assert.deepEqual(provider.getDegradations(), [
    {
      tool: 'native-review-lint',
      gate: 'scoped-lint',
      surface: 'scoped-lint',
      reason: 'unparseable-output',
    },
  ]);
});

test('runReview: a lint gate that executes reports no degradation, and a re-run clears the previous one (AC-5)', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('README.md\n'),
    runScopedLintFn: () => ({
      errors: 0,
      warnings: 0,
      parsed: true,
      executionFailed: false,
      skipped: false,
      mode: 'changed-only',
      degradations: [],
    }),
    analyzeChangedFilesFn: async () => ({
      totalFiles: 1,
      jsFiles: 0,
      maintainability: [],
      criticalFindings: [],
      mediumFindings: [],
    }),
    emitToolDegradationFn: async () => {
      throw new Error('friction must not be emitted for a healthy gate');
    },
  });

  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 4839,
    baseRef: 'main',
    headRef: 'story-4839',
  });

  assert.deepEqual(findings, []);
  assert.deepEqual(
    provider.getDegradations(),
    [],
    'a healthy gate must not report a degradation',
  );
});

test('runReview: lint errors from an executing runner still surface as a high finding alongside no degradation (AC-5)', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('a.js\n'),
    runScopedLintFn: () => ({
      errors: 2,
      warnings: 1,
      parsed: true,
      executionFailed: false,
      skipped: false,
      mode: 'changed-only',
      degradations: [],
    }),
    analyzeChangedFilesFn: async () => ({
      totalFiles: 1,
      jsFiles: 1,
      maintainability: [],
      criticalFindings: [],
      mediumFindings: [],
    }),
  });

  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 4839,
    baseRef: 'main',
    headRef: 'story-4839',
  });

  assert.deepEqual(
    findings.map((f) => f.severity),
    ['high'],
    'lint errors collapse into a single high finding (warnings ride in its body)',
  );
  assert.match(findings[0].title, /2 error\(s\)/);
  assert.deepEqual(provider.getDegradations(), []);
});

test('renderFindings: a degraded gate suppresses the unqualified "No findings" claim (Story #4839 AC-2)', () => {
  const degradations = [
    {
      tool: 'native-review-lint',
      gate: 'scoped-lint',
      surface: 'markdownlint',
      reason: 'runner-not-installed',
    },
  ];

  const degradedBody = renderFindings({
    ticketId: 4839,
    baseRef: 'main',
    headRef: 'story-4839',
    findings: [],
    provider: 'native',
    degradations,
  });

  assert.equal(
    degradedBody.includes('### ✅ No findings'),
    false,
    'a review that could not run a gate must never render an unqualified clean verdict',
  );
  assert.match(degradedBody, /Degraded gates\*\*: 1 \(did not run\)/);
  assert.match(degradedBody, /### ⚠️ Degraded Gates \(1\)/);
  assert.match(degradedBody, /scoped-lint.+markdownlint.+runner-not-installed/);
  assert.match(degradedBody, /### ⚠️ No findings — 1 gate\(s\) did not run/);

  // AC-3: the severity tally is untouched — the degradation is not a finding.
  assert.match(degradedBody, /- 🔴 Critical Blocker: 0/);
  assert.match(degradedBody, /- 🟠 High Risk: 0/);
  assert.match(degradedBody, /- 🟡 Medium Risk: 0/);
  assert.match(degradedBody, /- 🟢 Suggestion: 0/);
  assert.match(degradedBody, /\*\*Findings\*\*: 0/);
});

test('renderFindings: a healthy review body is byte-identical with an absent or empty degradation list (AC-5)', () => {
  const base = {
    ticketId: 4839,
    baseRef: 'main',
    headRef: 'story-4839',
    findings: [],
    provider: 'native',
  };

  const withoutField = renderFindings(base);
  const withEmpty = renderFindings({ ...base, degradations: [] });

  assert.equal(withEmpty, withoutField);
  assert.match(withoutField, /### ✅ No findings/);
  assert.equal(withoutField.includes('Degraded'), false);
});

/**
 * The maintainability dimension honours
 * `delivery.quality.gates.maintainability.ignoreGlobs`.
 *
 * Live defect (Story #5007 / PR #5022): the ratchet (`check-baselines.js`)
 * PASSED because the exempted `config-settings-schema*.js` files are absent
 * from the MI baseline, while this lens raised a critical blocker on the very
 * same files in the very same close run. A critical finding halts
 * `single-story-close.js` before auto-merge, so the two surfaces disagreeing
 * meant a hand-run merge was the only way to land legitimate work.
 *
 * The bar these tests hold: an exempted file produces NO finding at ANY
 * severity — not a downgraded one. The matching rules themselves are unit-tested
 * in `mi-exemptions.test.js`; these pin the provider's wiring and its output.
 */

/** The three real paths from PR #5022, and the glob that exempts all of them. */
const EXEMPT_FILES = [
  '.agents/scripts/lib/config-settings-schema-delivery.js',
  '.agents/scripts/lib/config-settings-schema-quality.js',
  '.agents/scripts/lib/config-settings-schema.js',
];
const EXEMPT_GLOB = '.agents/scripts/lib/config-settings-schema*.js';

/** A body fat enough to classify below the healthy tier when scored. */
const FAT_SOURCE = `export const blob = {\n${Array.from(
  { length: 400 },
  (_v, i) => `  key${i}: { a: ${i}, b: '${i}', c: [${i}, ${i + 1}] },`,
).join('\n')}\n};\n`;

/**
 * Build a provider whose diff is `files`, every one of them scoring badly if
 * scored at all — which is what makes "no finding" evidence of the exemption
 * rather than evidence of health.
 */
function providerOverFiles(files, { resolveIgnoreGlobsFn }) {
  const infoLines = [];
  const gitSpawnFn = (_cwd, sub) => {
    if (sub === 'diff')
      return { status: 0, stdout: `${files.join('\n')}\n`, stderr: '' };
    if (sub === 'show') return { status: 0, stdout: FAT_SOURCE, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const provider = createNativeProvider({
    gitSpawnFn,
    resolveIgnoreGlobsFn,
    logger: { info: (m) => infoLines.push(m), warn: () => {} },
    scopeLint: 'off',
  });
  return { provider, infoLines };
}

const REVIEW_INPUT = {
  scope: 'story',
  ticketId: 5007,
  baseRef: 'main',
  headRef: 'story-5007',
};

test('runReview: an exempt file produces no finding at any severity, and is named on the log', async () => {
  const { provider, infoLines } = providerOverFiles(EXEMPT_FILES, {
    resolveIgnoreGlobsFn: () => [EXEMPT_GLOB],
  });

  const findings = await provider.runReview(REVIEW_INPUT);

  // No finding of ANY severity — the whole point. A downgraded finding would
  // still be a false positive, just a quieter one.
  assert.deepEqual(findings, []);
  for (const severity of ALLOWED_SEVERITIES) {
    assert.equal(
      findings.filter((f) => f.severity === severity).length,
      0,
      `expected zero ${severity} findings on exempt files`,
    );
  }

  const exemptLine = infoLines.find((l) => l.includes('exempt via'));
  assert.ok(exemptLine, `expected an exemption log line, got: ${infoLines}`);
  assert.match(exemptLine, /3 changed file\(s\) exempt via/);
  for (const file of EXEMPT_FILES) assert.ok(exemptLine.includes(file));
});

test('runReview: exemptions spare only the matched files — an unmatched sibling still reports', async () => {
  const scoredPath = '.agents/scripts/lib/orchestration/some-runner.js';
  const { provider } = providerOverFiles([...EXEMPT_FILES, scoredPath], {
    resolveIgnoreGlobsFn: () => [EXEMPT_GLOB],
  });

  const findings = await provider.runReview(REVIEW_INPUT);

  assert.ok(findings.length > 0, 'the unmatched file must still be scored');
  for (const finding of findings) assert.equal(finding.file, scoredPath);
});

test('runReview: an empty exemption list scores every changed file', async () => {
  // Also the shape an unresolvable config degrades to — see
  // `mi-exemptions.test.js` for the fail-open itself. Scoring everything at
  // worst yields an advisory a human reads; failing the other way would
  // silently retire the dimension.
  const { provider, infoLines } = providerOverFiles(EXEMPT_FILES, {
    resolveIgnoreGlobsFn: () => [],
  });

  const findings = await provider.runReview(REVIEW_INPUT);

  assert.ok(findings.length > 0, 'nothing is exempt, so everything is scored');
  assert.equal(
    infoLines.some((l) => l.includes('exempt via')),
    false,
    'nothing was exempted, so nothing is reported as exempt',
  );
});
