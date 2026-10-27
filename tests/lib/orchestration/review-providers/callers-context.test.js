/**
 * Unit tests for `review-providers/callers-context.js` — Story #5764.
 *
 * Every test injects the git seam: none spawns a real `git grep`. The
 * symbols a diff yields are observed through the grep argv they produce.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCallersSection } from '../../../../.agents/scripts/lib/orchestration/review-providers/callers-context.js';

const CAPS = Object.freeze({
  maxSymbols: 20,
  maxLinesPerSymbol: 25,
  maxChars: 30_000,
});

const FIXTURE_DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,4 +1,4 @@',
  '-export function loadWidget(id) {',
  '+export async function loadWidgetById(id, opts) {',
  ' function untouchedHelper() {}',
  '+class WidgetCache extends Map {}',
  '+export const DEFAULT_TTL = 5;',
  '-export { alpha, beta as gamma };',
  'diff --git a/src/function-header.js b/src/function-header.js',
  '--- a/src/function headerOnlyOld.js',
  '+++ b/src/function-header.js',
  '@@ -1 +1 @@',
  '+let local = 1;',
].join('\n');

function grepResult(lines, status = 0) {
  return { status, stdout: lines.join('\n'), stderr: '' };
}

/**
 * @param {{ diff?: string, depth?: string, grep?: Function, caps?: object }} [opts]
 */
function run(opts = {}) {
  const calls = [];
  const section = buildCallersSection({
    diff: opts.diff ?? FIXTURE_DIFF,
    input: { headRef: 'story-1', depth: opts.depth ?? 'deep' },
    cwd: '/repo',
    gitSpawnFn: (cwd, ...args) => {
      calls.push({ cwd, args });
      return opts.grep?.(args) ?? grepResult([], 1);
    },
    ...(opts.caps ? { caps: opts.caps } : {}),
  });
  return { ...section, calls, grepped: calls.map((c) => c.args[5]) };
}

test('extracts function, class, export const and export-list names, longest first; headers and context ignored', () => {
  const { grepped } = run();
  assert.deepEqual(grepped, [
    'loadWidgetById',
    'DEFAULT_TTL',
    'WidgetCache',
    'loadWidget',
    'alpha',
    'gamma',
  ]);
});

test('prose never yields a symbol: words starting "function" and comment-only lines are skipped', () => {
  const diff = [
    'diff --git a/src/p.js b/src/p.js',
    '--- a/src/p.js',
    '+++ b/src/p.js',
    '@@ -1,6 +1,6 @@',
    '- * functional `minimatch()` recompiles per call',
    '+ * functions here; the function returns early',
    '+// function helperInComment() is documented above',
    '+/* class CommentedOut {} */',
    '+const functionalMode = true; // functions too',
    '+function foo() {}',
    '+function* gen() {}',
    '+export async function bar() {}',
  ].join('\n');
  const { grepped } = run({ diff });
  assert.deepEqual(grepped, ['bar', 'foo', 'gen']);
});

test('each lookup is a fixed-string word-boundary grep at the head ref excluding every changed file', () => {
  const { calls } = run();
  assert.ok(calls.every((c) => c.cwd === '/repo'));
  assert.deepEqual(calls[0].args, [
    'grep',
    '-n',
    '-w',
    '-F',
    '-e',
    'loadWidgetById',
    'story-1',
    '--',
    '.',
    ':(exclude)src/a.js',
    ':(exclude)src/function-header.js',
  ]);
});

test('below deep no grep runs and the section is empty', () => {
  for (const depth of ['light', 'standard', 'bogus']) {
    const { text, reason, calls } = run({ depth });
    assert.equal(text, '');
    assert.equal(reason, null);
    assert.equal(calls.length, 0);
  }
});

test('renders path:line: text under one heading per symbol inside <callers>', () => {
  const { text, reason } = run({
    grep: (args) =>
      args[5] === 'loadWidget'
        ? grepResult(['story-1:src/b.js:12:  return loadWidget(7);'])
        : undefined,
  });
  assert.match(text, /a caller the change breaks is a finding\./);
  assert.ok(
    text.endsWith(
      '<callers>\n## loadWidget\nsrc/b.js:12: return loadWidget(7);\n</callers>\n',
    ),
  );
  assert.equal(reason, null);
});

test('the symbol cap names the symbols it dropped', () => {
  const { grepped, reason } = run({ caps: { ...CAPS, maxSymbols: 5 } });
  assert.equal(grepped.length, 5);
  assert.equal(
    reason,
    'callers block incomplete; not checked: gamma (symbol cap)',
  );
});

test('the per-symbol line cap keeps 25 lines and names the overflow', () => {
  const hits = Array.from(
    { length: 30 },
    (_, i) => `story-1:x.js:${i + 1}:alpha()`,
  );
  const { text, reason } = run({
    diff: '+++ b/a.js\n@@ -0,0 +1 @@\n+export const alpha = 1;\n',
    grep: () => grepResult(hits),
  });
  assert.equal(
    text.split('\n').filter((l) => l.startsWith('x.js:')).length,
    25,
  );
  assert.equal(
    reason,
    'callers block incomplete; not checked: alpha (5 lines over cap)',
  );
});

test('the total character cap drops a section that would overflow it', () => {
  const { text, reason } = run({
    diff: '+++ b/a.js\n@@ -0,0 +2 @@\n+export const alphaLonger = 1;\n+export const beta = 2;\n',
    grep: (args) =>
      grepResult([
        `story-1:x.js:1:${'y'.repeat(args[5] === 'beta' ? 10 : 60)}`,
      ]),
    caps: { ...CAPS, maxChars: 90 },
  });
  assert.match(text, /## alphaLonger/);
  assert.doesNotMatch(text, /## beta/);
  assert.equal(
    reason,
    'callers block incomplete; not checked: beta (total cap)',
  );
});

test('a failed lookup is reported as unchecked, and no hits renders a placeholder', () => {
  const { text, reason } = run({
    diff: '+++ b/a.js\n@@ -0,0 +1 @@\n+function alpha() {}\n',
    grep: () => ({ status: 128, stdout: '', stderr: 'bad ref' }),
  });
  assert.match(text, /<callers>\n\(no references/);
  assert.equal(
    reason,
    'callers block incomplete; not checked: alpha (lookup failed)',
  );
});

const PROSE_DIFF = [
  'diff --git a/src/rules.js b/src/rules.js',
  '--- a/src/rules.js',
  '+++ b/src/rules.js',
  '@@ -0,0 +1,10 @@',
  '+export const BUG_CLASS_RULE =',
  '+  "Name each problem\'s bug class as a short kebab-case slug in `class`, " +',
  "+  'and the function is pure';",
  "+test('the prompt asks for a bug class and every instance', () => {});",
  '+const msg = `a class or function rules`;',
  "+export const URL_BASE = 'https://x.test/function nope';",
  '+export function markRepeats() {}',
  '+recordRun(); /* class the */ export class FindingLedger {}',
  '+const n = 1; // the function returns early',
  '+function findingId() {}',
  'diff --git a/docs/review.md b/docs/review.md',
  '--- a/docs/review.md',
  '+++ b/docs/review.md',
  '@@ -1 +1,2 @@',
  '+list. Its stable id (class or category, first instance file, and for a',
  '+the function is described as a review function rules',
].join('\n');

test('prose in strings, template literals, inline comments and docs hunks never yields a symbol', () => {
  const { grepped } = run({ diff: PROSE_DIFF });
  for (const word of ['and', 'as', 'is', 'or', 'rules', 'the', 'review']) {
    assert.ok(!grepped.includes(word), `stop-word "${word}" was grepped`);
  }
  assert.deepEqual(grepped, [
    'BUG_CLASS_RULE',
    'FindingLedger',
    'markRepeats',
    'findingId',
    'URL_BASE',
  ]);
});

test('the symbol cap is spent on real identifiers and names only real ones as dropped', () => {
  const { grepped, reason } = run({
    diff: PROSE_DIFF,
    caps: { ...CAPS, maxSymbols: 3 },
  });
  assert.deepEqual(grepped, ['BUG_CLASS_RULE', 'FindingLedger', 'markRepeats']);
  assert.equal(
    reason,
    'callers block incomplete; not checked: findingId (symbol cap), URL_BASE (symbol cap)',
  );
});
