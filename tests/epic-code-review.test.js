import assert from 'node:assert';
import { test } from 'node:test';
import {
  analyzeChangedFiles,
  buildLintLine,
  buildReviewReport,
  buildSeverity,
  classifyChangedFile,
  parseLintOutput,
  parseReviewArgs,
  partitionFilesForLint,
  runScopedLint,
} from '../.agents/scripts/epic-code-review.js';

test('parseLintOutput - clean run reports zero', () => {
  const out = parseLintOutput({
    status: 0,
    stdout: 'Checked 42 files in 120ms. No fixes applied.\n',
    stderr: '',
  });
  assert.deepStrictEqual(out, {
    errors: 0,
    warnings: 0,
    parsed: false,
    executionFailed: false,
  });
});

test('parseLintOutput - biome error + warning counts both captured', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: 'Checked 10 files.\nFound 2 errors.\nFound 3 warnings.\n',
    stderr: '',
  });
  assert.deepStrictEqual(out, {
    errors: 2,
    warnings: 3,
    parsed: true,
    executionFailed: false,
  });
});

test('parseLintOutput - warnings-only run stays below high-risk threshold', () => {
  const out = parseLintOutput({
    status: 0,
    stdout: 'Found 4 warnings.\n',
    stderr: '',
  });
  assert.strictEqual(out.errors, 0);
  assert.strictEqual(out.warnings, 4);
  assert.strictEqual(out.parsed, true);
});

test('parseLintOutput - markdownlint Summary line counted as error', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: 'file.md:3 MD022/blanks-around-headings\n\nSummary: 1 error\n',
    stderr: '',
  });
  assert.strictEqual(out.errors, 1);
  assert.strictEqual(out.parsed, true);
});

test('parseLintOutput - unknown failing runner is flagged executionFailed (not high risk)', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: 'some unexpected output\n',
    stderr: 'boom\n',
  });
  assert.strictEqual(out.errors, 0);
  assert.strictEqual(out.warnings, 0);
  assert.strictEqual(out.parsed, false);
  assert.strictEqual(out.executionFailed, true);
});

test('parseLintOutput - parsed run never sets executionFailed even when status is non-zero', () => {
  const out = parseLintOutput({
    status: 1,
    stdout: 'Found 5 errors.\n',
    stderr: '',
  });
  assert.strictEqual(out.errors, 5);
  assert.strictEqual(out.parsed, true);
  assert.strictEqual(out.executionFailed, false);
});

test('parseReviewArgs - rejects missing/invalid epic id', () => {
  assert.deepStrictEqual(parseReviewArgs([]), {
    epicId: null,
    baseBranch: null,
    post: true,
    scopeLint: 'changed-only',
    storyId: null,
    useEvidence: true,
  });
  assert.strictEqual(parseReviewArgs(['--epic', 'abc']).epicId, null);
  assert.strictEqual(parseReviewArgs(['--epic', '0']).epicId, null);
  assert.strictEqual(parseReviewArgs(['--epic', '-3']).epicId, null);
});

test('parseReviewArgs - parses epic and base', () => {
  assert.deepStrictEqual(
    parseReviewArgs(['--epic', '42', '--base', 'develop']),
    {
      epicId: 42,
      baseBranch: 'develop',
      post: true,
      scopeLint: 'changed-only',
      storyId: null,
      useEvidence: true,
    },
  );
});

test('parseReviewArgs - --story enables evidence skip when present', () => {
  const args = parseReviewArgs(['--epic', '42', '--story', '901']);
  assert.strictEqual(args.storyId, 901);
  assert.strictEqual(args.useEvidence, true);
});

test('parseReviewArgs - --no-evidence disables the skip', () => {
  const args = parseReviewArgs([
    '--epic',
    '42',
    '--story',
    '901',
    '--no-evidence',
  ]);
  assert.strictEqual(args.useEvidence, false);
});

test('parseReviewArgs - --scope-lint=off honored', () => {
  assert.strictEqual(
    parseReviewArgs(['--epic', '1', '--scope-lint', 'off']).scopeLint,
    'off',
  );
});

test('parseReviewArgs - unknown --scope-lint value falls back to changed-only', () => {
  assert.strictEqual(
    parseReviewArgs(['--epic', '1', '--scope-lint', 'all']).scopeLint,
    'changed-only',
  );
});

test('partitionFilesForLint - splits code, markdown, drops the rest', () => {
  const out = partitionFilesForLint([
    'a.js',
    'b.mjs',
    'c.cjs',
    'd.ts',
    'e.json',
    'f.md',
    'g.css',
    'h.png',
    'README.MD',
  ]);
  assert.deepStrictEqual(out.code, [
    'a.js',
    'b.mjs',
    'c.cjs',
    'd.ts',
    'e.json',
  ]);
  assert.deepStrictEqual(out.md, ['f.md', 'README.MD']);
});

test('runScopedLint - no JS/MD files in surface skips both runners', () => {
  let calls = 0;
  const runner = () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = runScopedLint(['a.css', 'b.png', 'c.yml'], '/cwd', runner);
  assert.strictEqual(
    calls,
    0,
    'runner must not be invoked when surface is empty',
  );
  assert.strictEqual(out.errors, 0);
  assert.strictEqual(out.warnings, 0);
  assert.strictEqual(out.parsed, false);
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(out.mode, 'changed-only');
});

test('runScopedLint - empty changedFiles list does not invoke any runner', () => {
  let calls = 0;
  const runner = () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = runScopedLint([], '/cwd', runner);
  assert.strictEqual(calls, 0);
  assert.strictEqual(out.skipped, true);
});

test('runScopedLint - invokes biome only on code files, never on workspace root', () => {
  const invocations = [];
  const runner = (bin, args) => {
    invocations.push({ bin, args });
    return {
      status: 0,
      stdout: 'Found 0 errors.\nFound 0 warnings.\n',
      stderr: '',
    };
  };
  runScopedLint(['src/a.js', 'src/b.js'], '/cwd', runner);
  assert.strictEqual(invocations.length, 1);
  assert.strictEqual(invocations[0].bin, 'biome');
  assert.deepStrictEqual(invocations[0].args, ['lint', 'src/a.js', 'src/b.js']);
  assert.ok(
    !invocations[0].args.includes('.'),
    'must not pass the workspace root to biome',
  );
});

test('runScopedLint - invokes markdownlint only on .md files', () => {
  const invocations = [];
  const runner = (bin, args) => {
    invocations.push({ bin, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  runScopedLint(['docs/a.md'], '/cwd', runner);
  assert.strictEqual(invocations.length, 1);
  assert.strictEqual(invocations[0].bin, 'markdownlint');
  assert.deepStrictEqual(invocations[0].args, [
    'docs/a.md',
    '--ignore',
    'node_modules',
  ]);
});

test('runScopedLint - aggregates errors across both runners', () => {
  const runner = (bin) => {
    if (bin === 'biome') {
      return {
        status: 1,
        stdout: 'Found 2 errors.\nFound 1 warning.\n',
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: 'Summary: 3 errors\n' };
  };
  const out = runScopedLint(['a.js', 'b.md'], '/cwd', runner);
  assert.strictEqual(out.errors, 5);
  assert.strictEqual(out.warnings, 1);
  assert.strictEqual(out.skipped, false);
  assert.strictEqual(out.mode, 'changed-only');
});

test('buildLintLine - mode=off renders the scoped-off banner', () => {
  const line = buildLintLine({
    errors: 0,
    warnings: 0,
    skipped: true,
    mode: 'off',
  });
  assert.match(line, /Lint Skipped/);
  assert.match(line, /scope-lint=off/);
});

test('buildLintLine - skipped (empty surface) renders the no-surface banner', () => {
  const line = buildLintLine({
    errors: 0,
    warnings: 0,
    skipped: true,
    mode: 'changed-only',
  });
  assert.match(line, /no JS or markdown files in changed surface/);
});

test('buildLintLine - clean changed-only run mentions changed surface', () => {
  const line = buildLintLine({
    errors: 0,
    warnings: 0,
    skipped: false,
    mode: 'changed-only',
  });
  assert.match(line, /changed surface is clean/);
});

test('classifyChangedFile - critical tier with low worst method', () => {
  const out = classifyChangedFile('foo.js', {
    reportFn: () => ({ moduleScore: 5, worstMethod: 12 }),
    classifier: () => 'critical',
  });
  assert.strictEqual(out.row.tier, 'critical');
  assert.match(out.criticalIssue, /worst method 12.0/);
  assert.strictEqual(out.warningIssue, null);
});

test('classifyChangedFile - critical tier falls back to module score', () => {
  const out = classifyChangedFile('foo.js', {
    reportFn: () => ({ moduleScore: 18.4, worstMethod: 25 }),
    classifier: () => 'critical',
  });
  assert.match(out.criticalIssue, /module score 18.4/);
});

test('classifyChangedFile - warning tier emits size/volume row', () => {
  const out = classifyChangedFile('foo.js', {
    reportFn: () => ({ moduleScore: 60.5, worstMethod: 30.3 }),
    classifier: () => 'warning',
  });
  assert.strictEqual(out.criticalIssue, null);
  assert.match(out.warningIssue, /Size\/Volume Warning/);
  assert.match(out.warningIssue, /worst method 30.3/);
});

test('classifyChangedFile - warning tier without worstMethod', () => {
  const out = classifyChangedFile('foo.js', {
    reportFn: () => ({ moduleScore: 70, worstMethod: null }),
    classifier: () => 'warning',
  });
  assert.match(out.warningIssue, /module 70.0\)/);
});

test('classifyChangedFile - swallows file-deleted reportFn errors', () => {
  const out = classifyChangedFile('gone.js', {
    reportFn: () => {
      throw new Error('ENOENT');
    },
    classifier: () => 'healthy',
  });
  assert.deepStrictEqual(out, {
    row: null,
    criticalIssue: null,
    warningIssue: null,
  });
});

test('analyzeChangedFiles - skips non-JS files and accumulates tiers', () => {
  const reports = new Map([
    ['a.js', { moduleScore: 80, worstMethod: 50 }],
    ['b.mjs', { moduleScore: 60, worstMethod: 40 }],
    ['c.cjs', { moduleScore: 10, worstMethod: 5 }],
  ]);
  const tiers = new Map([
    [80, 'healthy'],
    [60, 'warning'],
    [10, 'critical'],
  ]);
  const out = analyzeChangedFiles(['a.js', 'b.mjs', 'c.cjs', 'd.md', 'e.txt'], {
    reportFn: (abs) => {
      const key = [...reports.keys()].find((k) => abs.endsWith(k));
      return reports.get(key);
    },
    classifier: (r) => tiers.get(r.moduleScore),
  });
  assert.strictEqual(out.totalFiles, 5);
  assert.strictEqual(out.jsFiles, 3);
  assert.strictEqual(out.maintainability.length, 3);
  assert.strictEqual(out.criticalIssues.length, 1);
  assert.strictEqual(out.warningIssues.length, 1);
});

test('analyzeChangedFiles - drops files where reportFn throws', () => {
  const out = analyzeChangedFiles(['bad.js'], {
    reportFn: () => {
      throw new Error('parse failed');
    },
    classifier: () => 'healthy',
  });
  assert.strictEqual(out.jsFiles, 1);
  assert.strictEqual(out.maintainability.length, 0);
});

test('buildSeverity - composes tally and lint counts', () => {
  const out = buildSeverity(
    { criticalIssues: ['x', 'y'], warningIssues: ['z'] },
    { errors: 3, warnings: 0 },
  );
  assert.deepStrictEqual(out, {
    critical: 2,
    high: 1,
    medium: 1,
    suggestion: 0,
  });
});

test('buildSeverity - executionFailed downgrades to suggestion (not high risk)', () => {
  const out = buildSeverity(
    { criticalIssues: [], warningIssues: ['z'] },
    { errors: 0, warnings: 0, executionFailed: true },
  );
  assert.deepStrictEqual(out, {
    critical: 0,
    high: 0,
    medium: 1,
    suggestion: 1,
  });
});

test('buildLintLine - executionFailed renders the could-not-execute banner', () => {
  const line = buildLintLine({
    errors: 0,
    warnings: 0,
    executionFailed: true,
    skipped: false,
    mode: 'changed-only',
  });
  assert.match(line, /Lint Runner Could Not Execute/);
  assert.match(line, /skipped gate/);
  assert.match(line, /npm run lint/);
});

test('buildLintLine - error / warning / clean variants', () => {
  assert.match(
    buildLintLine({ errors: 2, warnings: 0 }),
    /Lint Check Failed.*2 error/,
  );
  assert.match(
    buildLintLine({ errors: 0, warnings: 1 }),
    /Passed with Warnings.*1 warning/,
  );
  assert.strictEqual(
    buildLintLine({ errors: 0, warnings: 0 }),
    '✅ **Lint Check Passed**: changed surface is clean.',
  );
});

test('buildReviewReport - assembles the markdown body deterministically', () => {
  const body = buildReviewReport({
    epicId: 7,
    baseBranch: 'main',
    epicBranch: 'epic/7',
    results: {
      totalFiles: 4,
      jsFiles: 3,
      maintainability: [
        {
          file: 'a.js',
          report: { moduleScore: 80, worstMethod: 50 },
          tier: 'healthy',
        },
        {
          file: 'b.js',
          report: { moduleScore: 60, worstMethod: null },
          tier: 'warning',
        },
        {
          file: 'c.js',
          report: { moduleScore: 10, worstMethod: 5 },
          tier: 'critical',
        },
      ],
      criticalIssues: ['🔴 Low Maintainability: `c.js` (worst method 5.0)'],
      warningIssues: ['🟡 Size/Volume Warning: `b.js` (module 60.0)'],
    },
    severity: { critical: 1, high: 0, medium: 1, suggestion: 0 },
    lintLine: '✅ ok',
  });
  assert.match(body, /Epic #7/);
  assert.match(body, /4 files changed \(3 JS files\)/);
  assert.match(body, /🟢 Healthy/);
  assert.match(body, /🟡 Warning/);
  assert.match(body, /🔴 Critical/);
  assert.match(body, /Low Maintainability: `c.js`/);
  assert.match(body, /Size\/Volume Warning: `b.js`/);
  assert.ok(body.endsWith('verify business logic and security constraints._'));
});

test('buildReviewReport - empty issue lists render the green-path lines', () => {
  const body = buildReviewReport({
    epicId: 1,
    baseBranch: 'main',
    epicBranch: 'epic/1',
    results: {
      totalFiles: 0,
      jsFiles: 0,
      maintainability: [],
      criticalIssues: [],
      warningIssues: [],
    },
    severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
    lintLine: '✅ clean',
  });
  assert.match(body, /No maintainability blockers identified\./);
  assert.match(body, /No size\/volume warnings\./);
});

test('buildReviewReport - parse-error tier emits the warning glyph', () => {
  const body = buildReviewReport({
    epicId: 9,
    baseBranch: 'main',
    epicBranch: 'epic/9',
    results: {
      totalFiles: 1,
      jsFiles: 1,
      maintainability: [
        {
          file: 'broken.js',
          report: { moduleScore: 0, worstMethod: null },
          tier: 'parse-error',
        },
      ],
      criticalIssues: [],
      warningIssues: [],
    },
    severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
    lintLine: '✅',
  });
  assert.match(body, /⚠️ Parse Error/);
});
