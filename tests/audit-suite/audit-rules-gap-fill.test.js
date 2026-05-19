// tests/audit-suite/audit-rules-gap-fill.test.js
//
// Completeness invariant: every audit-*.md lens workflow under
// `.agents/workflows/` must have a matching entry in
// `.agents/schemas/audit-rules.json`, so selector.js can route every lens.
//
// Exclusions:
//   - audit-fan-out.md  — meta workflow being deprecated by Epic #2586.
//   - audit-to-stories.md — tooling workflow (audit-MD → GitHub Stories
//                           converter), not a routable lens.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WORKFLOWS_DIR = path.join(REPO_ROOT, '.agents', 'workflows');
const RULES_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'schemas',
  'audit-rules.json',
);

const NON_LENS_EXCLUSIONS = new Set(['audit-fan-out', 'audit-to-stories']);

function enumerateLensNames() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.startsWith('audit-') && name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''))
    .filter((name) => !NON_LENS_EXCLUSIONS.has(name))
    .sort();
}

function loadRuleKeys() {
  const raw = readFileSync(RULES_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return Object.keys(parsed.audits ?? {}).sort();
}

test('audit-rules.json has an entry for every audit-*.md lens', () => {
  const lenses = enumerateLensNames();
  const ruleKeys = loadRuleKeys();

  const missing = lenses.filter((name) => !ruleKeys.includes(name));
  assert.deepEqual(
    missing,
    [],
    `audit-rules.json is missing entries for: ${missing.join(', ')}`,
  );
});

test('audit-rules.json has no stale entries without a backing audit-*.md lens', () => {
  const lenses = new Set(enumerateLensNames());
  const ruleKeys = loadRuleKeys();

  const stale = ruleKeys.filter((name) => !lenses.has(name));
  assert.deepEqual(
    stale,
    [],
    `audit-rules.json has entries with no matching workflow file: ${stale.join(
      ', ',
    )}`,
  );
});
