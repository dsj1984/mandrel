// tests/audit-suite/code-review-trim.test.js
//
// Contract test for the trimmed code-review helper shape.
//
// Pins the post-trim contract from Story #2614 so future helper edits cannot
// silently re-broaden the pillar roster or drop the per-finding "Agent Prompt"
// field. Story #4350 intentionally added a fourth pillar (Anti-Gaming /
// Shortcut Detection), so the pinned roster count is now four — the test
// guards against *accidental* roster drift, not the deliberate #4350
// expansion. The helper is read straight off disk; we don't import a parser
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
  'code-review.md',
);

function loadHelper() {
  return readFileSync(HELPER_PATH, 'utf8');
}

test('code-review.md declares exactly four pillar headings', () => {
  // Arrange
  const body = loadHelper();

  // Act — match all "### Pillar N: <name>" headings.
  const matches = body.match(/^### Pillar \d+: .+$/gm) ?? [];

  // Assert — three trimmed pillars (Story #2614) plus the Anti-Gaming /
  // Shortcut Detection pillar added by Story #4350.
  assert.equal(
    matches.length,
    4,
    `expected exactly 4 pillar headings, got ${matches.length}: ${JSON.stringify(matches)}`,
  );
});

test('code-review.md keeps Pillar 1 (Spec Adherence)', () => {
  const body = loadHelper();
  assert.match(body, /^### Pillar 1: Spec Adherence$/m);
});

test('code-review.md renumbers the merged middle pillar to Pillar 2: Integration Review', () => {
  const body = loadHelper();
  assert.match(body, /^### Pillar 2: Integration Review$/m);
});

test('code-review.md keeps Pillar 6 content, renumbered to Pillar 3: Documentation Integrity', () => {
  const body = loadHelper();
  assert.match(body, /^### Pillar 3: Documentation Integrity$/m);
});

test('code-review.md adds Pillar 4 (Anti-Gaming / Shortcut Detection) enumerating the shortcut taxonomy', () => {
  const body = loadHelper();
  assert.match(body, /^### Pillar 4: Anti-Gaming \/ Shortcut Detection$/m);
  // Slice the Pillar 4 section so taxonomy assertions don't match prose
  // elsewhere in the helper.
  const pillar4Match = body.match(
    /^### Pillar 4: Anti-Gaming \/ Shortcut Detection\b([\s\S]*?)(?=^## Step )/m,
  );
  assert.ok(pillar4Match, 'Pillar 4 section not found');
  const section = pillar4Match[1];
  for (const term of [
    /relaxed tests/i,
    /skipped tests/i,
    /swallowed errors/i,
    /stub returns/i,
    /fake renames/i,
    /comment-deletion-as-fix/i,
  ]) {
    assert.match(
      section,
      term,
      `Pillar 4 must enumerate the ${term} taxonomy item`,
    );
  }
});

test('Pillar 2 body references the unified verification-results comment', () => {
  const body = loadHelper();
  // The merged Integration Review pillar must point reviewers at the
  // unified verification-results comment (Story #4411 retired the
  // separate audit-results comment; Story #4412 folded the lens walk into
  // this pass). NOTE: the pre-#4411 version of this test matched the bare
  // string /audit-results/, which after the fold passed only because
  // Pillar 2 contained the NEGATION sentence "There is no separate
  // `audit-results` comment to read" — an inverted assertion. Match the
  // real contract instead.
  const pillar2Match = body.match(
    /^### Pillar 2: Integration Review\b([\s\S]*?)(?=^### Pillar 3:|^## Step )/m,
  );
  assert.ok(pillar2Match, 'Pillar 2 section not found');
  assert.match(
    pillar2Match[1],
    /verification-results/,
    'Pillar 2 must reference the unified verification-results comment',
  );
});

test("Step 4 finding template documents an 'Agent Prompt' field", () => {
  const body = loadHelper();
  // Slice from Step 4's heading to the next top-level Step heading so we
  // don't pick up an "Agent Prompt" mention from elsewhere in the file.
  // Match Step 4 header through to either the next "## Step N" heading
  // or end-of-file (the `[\s\S]+$` tail handles the no-following-step case).
  const step4Match =
    body.match(/^## Step 4 [\s\S]*?(?=^## Step \d)/m) ??
    body.match(/^## Step 4 [\s\S]+$/m);
  assert.ok(step4Match, 'Step 4 section not found');
  assert.match(
    step4Match[0],
    /\bAgent Prompt\b/,
    "Step 4 must document an 'Agent Prompt' field on each finding",
  );
});
