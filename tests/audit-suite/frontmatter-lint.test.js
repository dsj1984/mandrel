import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_MODEL_HINTS,
  validateFrontmatter,
} from '../../.agents/scripts/lib/audit-suite/frontmatter-lint.js';

const mdWith = (line) => `---\ndescription: x\n${line}\n---\n`;

test('validateFrontmatter: passes when no model-hint field is set', () => {
  assert.deepEqual(validateFrontmatter(mdWith('')), { ok: true, errors: [] });
  assert.deepEqual(validateFrontmatter(''), { ok: true, errors: [] });
  assert.deepEqual(validateFrontmatter({}), { ok: true, errors: [] });
});

test('validateFrontmatter: accepts each allowed enum value on dispatchModel', () => {
  for (const value of ALLOWED_MODEL_HINTS) {
    const result = validateFrontmatter(mdWith(`dispatchModel: ${value}`));
    assert.equal(result.ok, true, `dispatchModel=${value} should validate`);
  }
});

test('validateFrontmatter: rejects arbitrary string with enum-violation error', () => {
  const result = validateFrontmatter(mdWith('dispatchModel: gpt-4'));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, 'dispatchModel');
  assert.equal(result.errors[0].value, 'gpt-4');
  assert.match(result.errors[0].message, /Invalid dispatchModel/);
  assert.match(result.errors[0].message, /haiku.*sonnet.*opus/);
});

test('validateFrontmatter: ignores recommendedModel after Story #2590 removal', () => {
  // The field was deleted from MODEL_HINT_FIELDS — a stale workflow that
  // still declares it should pass the lint (not throw or false-positive).
  const result = validateFrontmatter(mdWith('recommendedModel: claude-2'));
  assert.equal(result.ok, true);
});

test('validateFrontmatter: accepts a pre-parsed map directly', () => {
  assert.equal(validateFrontmatter({ dispatchModel: 'haiku' }).ok, true);
  assert.equal(validateFrontmatter({ dispatchModel: 'mystery' }).ok, false);
});

test('validateFrontmatter: case-sensitive enum (uppercase rejected)', () => {
  for (const value of ['Haiku', 'OPUS', 'Sonnet']) {
    assert.equal(validateFrontmatter({ dispatchModel: value }).ok, false);
  }
});

test('ALLOWED_MODEL_HINTS: matches the documented enum exactly', () => {
  assert.deepEqual([...ALLOWED_MODEL_HINTS], ['haiku', 'sonnet', 'opus']);
});
