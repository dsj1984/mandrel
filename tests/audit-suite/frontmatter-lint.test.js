import assert from 'node:assert/strict';
import test from 'node:test';

import { validateFrontmatter } from '../../.agents/scripts/lib/audit-suite/frontmatter-lint.js';

const mdWith = (line) => `---\ndescription: x\n${line}\n---\n`;

test('validateFrontmatter: passes on empty or arbitrary frontmatter (no field rules)', () => {
  assert.deepEqual(validateFrontmatter(mdWith('')), { ok: true, errors: [] });
  assert.deepEqual(validateFrontmatter(''), { ok: true, errors: [] });
  assert.deepEqual(validateFrontmatter({}), { ok: true, errors: [] });
});

test('validateFrontmatter: ignores stale model-hint fields after Story #2824 removal', () => {
  // dispatchModel and recommendedModel were stripped from every workflow in
  // Epic #2815 / Story #2824; a stale workflow that still declares either
  // should pass the lint (no false-positives, no throws).
  assert.equal(validateFrontmatter(mdWith('dispatchModel: haiku')).ok, true);
  assert.equal(validateFrontmatter(mdWith('dispatchModel: gpt-4')).ok, true);
  assert.equal(
    validateFrontmatter(mdWith('recommendedModel: claude-2')).ok,
    true,
  );
});

test('validateFrontmatter: accepts a pre-parsed map directly', () => {
  assert.equal(validateFrontmatter({ description: 'x' }).ok, true);
  assert.equal(validateFrontmatter({ dispatchModel: 'mystery' }).ok, true);
});
