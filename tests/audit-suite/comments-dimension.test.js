import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const lens = readFileSync(
  path.join(REPO_ROOT, '.agents/workflows/audit-clean-code.md'),
  'utf8',
);
const flat = (text) => text.replace(/\s+/g, ' ');

const start = lens.indexOf('6. **Comments:**');
const dimension = lens.slice(start, lens.indexOf('\n## Report additions'));

const KINDS = [
  ['Tautology', /beside the line it restates/],
  ['Dead reference', /failed path probe or search/],
  ['History narration', /search count across the scope/],
  ['Unenforced constraint', /no type, test or lint holds it/],
];

test('the lens carries a Comments dimension in its evaluation dimensions', () => {
  assert.ok(start > lens.indexOf('## Step 2: Evaluation Dimensions'));
  assert.doesNotMatch(lens, /\*\*Documentation:\*\*/);
  assert.match(dimension, /code-quality-guardrails\.md#comments/);
});

test('each of the four finding kinds names the evidence it requires', () => {
  const rows = dimension.split('\n').filter((line) => /^\s*\| /.test(line));
  for (const [kind, evidence] of KINDS) {
    const row = rows.find((line) => line.includes(`| ${kind} |`));
    assert.ok(row, `no row for ${kind}`);
    assert.match(row, evidence);
  }
});

test('the dimension keeps the rewrite and no-formula guards', () => {
  const text = flat(dimension);
  assert.match(text, /sketches the type, test or lint/);
  assert.match(text, /is rewritten, not deleted/);
  assert.match(
    text,
    /never a comment-ratio target or trimming comments by formula/,
  );
  assert.match(text, /one finding per pattern .* never one per comment/);
});

test('Step 0 runs the comment searches before the model judges', () => {
  const step0 = lens.slice(
    lens.indexOf('## Step 0'),
    lens.indexOf('## Step 1: Quality Scan'),
  );
  assert.match(step0, /\*\*Comment searches\.\*\*/);
  assert.match(flat(step0), /no search behind it is not reported/);
});
