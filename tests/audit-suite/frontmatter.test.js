import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampSummary,
  extractFrontmatter,
} from '../../.agents/scripts/lib/audit-suite/frontmatter.js';

test('extractFrontmatter: returns {} when no leading --- block is present', () => {
  assert.deepEqual(extractFrontmatter(''), {});
  assert.deepEqual(extractFrontmatter('# heading\n\nbody'), {});
});

test('extractFrontmatter: parses key/value lines and unwraps quotes', () => {
  const md = [
    '---',
    'description: hello world',
    "kind: 'audit'",
    '---',
    '',
  ].join('\n');
  assert.deepEqual(extractFrontmatter(md), {
    description: 'hello world',
    kind: 'audit',
  });
});

test('extractFrontmatter: skips lines without a colon separator', () => {
  const md = ['---', 'no-colon-here', 'good: yes', '---', ''].join('\n');
  assert.deepEqual(extractFrontmatter(md), { good: 'yes' });
});

test('extractFrontmatter: tolerates CRLF line endings', () => {
  const md = '---\r\ndescription: crlf-safe\r\n---\r\nbody';
  assert.deepEqual(extractFrontmatter(md), { description: 'crlf-safe' });
});

test('clampSummary: trims to three sentences max', () => {
  const text = 'One. Two. Three. Four.';
  const out = clampSummary(text);
  assert.match(out, /^One\..*Two\..*Three\./);
  assert.doesNotMatch(out, /Four/);
});

test('clampSummary: respects 280-char ceiling and adds ellipsis', () => {
  const long = `${'A'.repeat(500)}.`;
  const result = clampSummary(long);
  assert.ok(result.length <= 280, `expected ≤280, got ${result.length}`);
  assert.ok(result.endsWith('…'));
});

test('clampSummary: returns "" for empty/whitespace input', () => {
  assert.equal(clampSummary(''), '');
  assert.equal(clampSummary('   \n  '), '');
});

test('clampSummary: returns text verbatim when no sentence terminator', () => {
  assert.equal(
    clampSummary('one paragraph no period'),
    'one paragraph no period',
  );
});
