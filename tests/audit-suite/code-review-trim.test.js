// tests/audit-suite/code-review-trim.test.js
//
// Contract test for the trimmed code-review helper shape.
//
// Pins the post-trim contract from Story #2614 so future helper edits cannot
// silently re-broaden the pillar roster or drop the per-finding "Agent Prompt"
// field. The helper is read straight off disk; we don't import a parser
// because the helper *is* the source of truth — anything we'd parse from it
// is what we want to assert against.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const HELPER_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'helpers',
  'epic-code-review.md',
);

function loadHelper() {
  return readFileSync(HELPER_PATH, 'utf8');
}

test('epic-code-review.md declares exactly three pillar headings', () => {
  // Arrange
  const body = loadHelper();

  // Act — match all "### Pillar N: <name>" headings.
  const matches = body.match(/^### Pillar \d+: .+$/gm) ?? [];

  // Assert
  assert.equal(
    matches.length,
    3,
    `expected exactly 3 pillar headings after trim, got ${matches.length}: ${JSON.stringify(matches)}`,
  );
});

test('epic-code-review.md keeps Pillar 1 (Spec Adherence)', () => {
  const body = loadHelper();
  assert.match(body, /^### Pillar 1: Spec Adherence$/m);
});

test('epic-code-review.md renumbers the merged middle pillar to Pillar 2: Integration Review', () => {
  const body = loadHelper();
  assert.match(body, /^### Pillar 2: Integration Review$/m);
});

test('epic-code-review.md keeps Pillar 6 content, renumbered to Pillar 3: Documentation Integrity', () => {
  const body = loadHelper();
  assert.match(body, /^### Pillar 3: Documentation Integrity$/m);
});

test('Pillar 2 body references the audit-results structured comment', () => {
  const body = loadHelper();
  // The merged Integration Review pillar must point reviewers at the
  // audit-results comment posted by the epic-audit helper, otherwise it
  // would silently re-duplicate Phase 4's audit work.
  const pillar2Match = body.match(
    /^### Pillar 2: Integration Review\b([\s\S]*?)(?=^### Pillar 3:|^## Step )/m,
  );
  assert.ok(pillar2Match, 'Pillar 2 section not found');
  assert.match(
    pillar2Match[1],
    /audit-results/,
    'Pillar 2 must reference the audit-results structured comment',
  );
});

test("Step 4 finding template documents an 'Agent Prompt' field", () => {
  const body = loadHelper();
  // Slice from Step 4's heading to the next top-level Step heading so we
  // don't pick up an "Agent Prompt" mention from elsewhere in the file.
  const step4Match = body.match(/^## Step 4 [\s\S]*?(?=^## Step \d|\Z)/m);
  assert.ok(step4Match, 'Step 4 section not found');
  assert.match(
    step4Match[0],
    /\bAgent Prompt\b/,
    "Step 4 must document an 'Agent Prompt' field on each finding",
  );
});
