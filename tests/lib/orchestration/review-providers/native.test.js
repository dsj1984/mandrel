/**
 * Unit tests for the native ReviewProvider adapter.
 *
 * Story #2833 (Epic #2815) — verifies:
 *   - runReview returns Finding[] (never throws, never posts).
 *   - Severity ∈ {critical, high, medium, suggestion} only.
 *   - Empty diff → empty findings.
 *   - Maintainability critical/warning tiers map to critical/medium
 *     findings, healthy tier is filtered out.
 *   - No GitHub provider methods are called from the adapter.
 *   - Invalid input shapes throw a TypeError.
 *
 * Story #5517 — the provider runs no lint: lint is a close-validation gate
 * the worker's preflight also runs, so a scoped pass only re-reported it. The
 * scoped-lint suites left with the module; the renderer's degraded-gate
 * contract below stays, since any provider may report a degradation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderFindings } from '../../../../.agents/scripts/lib/orchestration/review-providers/findings-renderer.js';
import {
  analyzeChangedFiles,
  classifyChangedFile,
  createNativeProvider,
  readHeadSource,
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

test('runReview: empty diff returns []', async () => {
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff(''),
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
  // Canonical ordering: critical before medium; no lint finding joins them.
  const severities = findings.map((f) => f.severity);
  assert.deepEqual(severities, ['critical', 'medium']);
  assert.equal(
    findings.some((f) => f.category === 'lint'),
    false,
  );
});

test('runReview: never invokes a GitHub provider method', async () => {
  // The adapter does not receive a GitHub provider at all — verifying the
  // shape contract: createNativeProvider takes no provider, and runReview
  // returns Finding[] without any external posting.
  const provider = createNativeProvider({
    gitSpawnFn: fakeDiff('a.js\n'),
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
