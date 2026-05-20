import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * .husky/pre-commit invariants — Story #1395 / Epic #1386.
 *
 * Husky v9 owns the hook **file** (it ensures the file exists and is wired
 * up via core.hooksPath). The contents are owned by the project. These
 * assertions pin the contract so a future `npm run prepare` (which runs
 * `husky` and re-exports the hooks dir) cannot silently drop the
 * quality:preview invocation, and so the line stays idempotent — running
 * `prepare` twice must not produce a duplicate invocation.
 */

const HOOK_PATH = path.resolve('.husky/pre-commit');

function readHook() {
  return fs.readFileSync(HOOK_PATH, 'utf-8');
}

test('.husky/pre-commit exists and is non-empty', () => {
  assert.ok(fs.existsSync(HOOK_PATH), '.husky/pre-commit must exist');
  const body = readHook();
  assert.ok(body.length > 0, 'pre-commit hook must be non-empty');
});

test('.husky/pre-commit invokes quality-preview.js with --staged only', () => {
  const body = readHook();
  assert.match(body, /node \.agents\/scripts\/quality-preview\.js/);
  assert.match(body, /--staged/);
  assert.doesNotMatch(body, /--changed-since/);
});

test('.husky/pre-commit is idempotent under repeated `npm run prepare`', () => {
  // The "prepare" step runs `husky && npm run sync:commands`. husky v9
  // never modifies an existing hook file's body (it only ensures
  // core.hooksPath points at .husky/), so the hook is already idempotent
  // by virtue of being a checked-in script. The contract that matters in
  // practice is "no duplicate quality:preview invocation". We assert that
  // by counting the invocation and refusing to count more than once.
  const body = readHook();
  const matches = body.match(/quality-preview\.js/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `expected exactly one quality-preview.js invocation in pre-commit hook, found ${matches.length}`,
  );
});

test('.husky/pre-commit preserves the existing version-sync + lint-staged gates', () => {
  const body = readHook();
  // The original two gates must stay in place — the new line is additive.
  assert.match(body, /node scripts\/check-version-sync\.js/);
  assert.match(body, /npx lint-staged/);
});

test('quality-preview invocation appears AFTER lint-staged so format fixes land first', () => {
  const body = readHook();
  const lintIdx = body.indexOf('lint-staged');
  const previewIdx = body.indexOf('quality-preview.js');
  assert.ok(lintIdx >= 0 && previewIdx >= 0, 'both lines must be present');
  assert.ok(
    previewIdx > lintIdx,
    'quality:preview must run after lint-staged so format/lint fixes are applied before MI/CRAP scoring',
  );
});
