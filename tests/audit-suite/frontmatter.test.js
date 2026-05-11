import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_MODEL_HINTS,
  clampSummary,
  extractFrontmatter,
  firstProseParagraph,
  summarizeWorkflow,
  validateFrontmatter,
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

test('firstProseParagraph: skips frontmatter, headings, and rules', () => {
  const md = [
    '---',
    'description: x',
    '---',
    '',
    '# Title',
    '',
    '## Sub',
    '',
    'First real paragraph.\nWith two lines.',
    '',
    'Second paragraph (ignored).',
  ].join('\n');
  assert.equal(
    firstProseParagraph(md),
    'First real paragraph. With two lines.',
  );
});

test('firstProseParagraph: returns "" when only headings are present', () => {
  assert.equal(firstProseParagraph('# only\n\n## headings\n'), '');
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

test('summarizeWorkflow: prefers frontmatter description over body', () => {
  const md = [
    '---',
    'description: From frontmatter.',
    '---',
    '',
    'Body should be ignored.',
  ].join('\n');
  assert.equal(summarizeWorkflow(md), 'From frontmatter.');
});

test('summarizeWorkflow: falls back to first paragraph when no description', () => {
  const md = ['# Title', '', 'Body sentence one. Body sentence two.'].join(
    '\n',
  );
  const out = summarizeWorkflow(md);
  assert.match(out, /Body sentence one\./);
});

// ---------------------------------------------------------------------------
// validateFrontmatter — model-hint lint (Story #1324, Epic #1185)
// ---------------------------------------------------------------------------

test('validateFrontmatter: passes when neither model-hint field is set', () => {
  const md = ['---', 'description: no hints here', '---', ''].join('\n');
  const result = validateFrontmatter(md);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateFrontmatter: passes when both fields are unset (empty frontmatter)', () => {
  assert.deepEqual(validateFrontmatter(''), { ok: true, errors: [] });
  assert.deepEqual(validateFrontmatter({}), { ok: true, errors: [] });
});

test('validateFrontmatter: accepts each allowed enum value on each field', () => {
  for (const field of ['recommendedModel', 'dispatchModel']) {
    for (const value of ALLOWED_MODEL_HINTS) {
      const md = [
        '---',
        'description: x',
        `${field}: ${value}`,
        '---',
        '',
      ].join('\n');
      const result = validateFrontmatter(md);
      assert.equal(
        result.ok,
        true,
        `expected ${field}=${value} to validate, got ${JSON.stringify(result.errors)}`,
      );
      assert.deepEqual(result.errors, []);
    }
  }
});

test('validateFrontmatter: accepts both fields set to enum values simultaneously', () => {
  const md = [
    '---',
    'description: dual hints',
    'recommendedModel: opus',
    'dispatchModel: haiku',
    '---',
    '',
  ].join('\n');
  const result = validateFrontmatter(md);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateFrontmatter: rejects an arbitrary string with a clear enum-violation error', () => {
  const md = [
    '---',
    'description: invalid hint',
    'dispatchModel: gpt-4',
    '---',
    '',
  ].join('\n');
  const result = validateFrontmatter(md);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, 'dispatchModel');
  assert.equal(result.errors[0].value, 'gpt-4');
  assert.match(result.errors[0].message, /Invalid dispatchModel/);
  assert.match(result.errors[0].message, /haiku/);
  assert.match(result.errors[0].message, /sonnet/);
  assert.match(result.errors[0].message, /opus/);
});

test('validateFrontmatter: rejects invalid recommendedModel value', () => {
  const md = [
    '---',
    'description: invalid recommended',
    'recommendedModel: claude-2',
    '---',
    '',
  ].join('\n');
  const result = validateFrontmatter(md);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'recommendedModel');
  assert.equal(result.errors[0].value, 'claude-2');
});

test('validateFrontmatter: reports both invalid fields when both are set', () => {
  const md = [
    '---',
    'description: both bad',
    'recommendedModel: bogus',
    'dispatchModel: alsoBogus',
    '---',
    '',
  ].join('\n');
  const result = validateFrontmatter(md);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  const fields = result.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['dispatchModel', 'recommendedModel']);
});

test('validateFrontmatter: accepts a pre-parsed frontmatter map directly', () => {
  assert.deepEqual(
    validateFrontmatter({ description: 'x', dispatchModel: 'haiku' }),
    { ok: true, errors: [] },
  );
  const bad = validateFrontmatter({ dispatchModel: 'mystery' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].field, 'dispatchModel');
});

test('validateFrontmatter: case-sensitive — uppercase or capitalised values are rejected', () => {
  for (const value of ['Haiku', 'OPUS', 'Sonnet']) {
    const result = validateFrontmatter({ dispatchModel: value });
    assert.equal(
      result.ok,
      false,
      `expected ${value} to be rejected (case-sensitive enum)`,
    );
  }
});

test('ALLOWED_MODEL_HINTS: matches the documented enum exactly', () => {
  assert.deepEqual([...ALLOWED_MODEL_HINTS], ['haiku', 'sonnet', 'opus']);
});
