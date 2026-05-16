// tests/issue-link-parser.test.js
//
// Lock the parser contract for Story #2091: round-trip a representative
// Epic body through `parseLinkedIssues` and assert each artefact slot
// (`prd`, `techSpec`, `acceptanceSpec`) populates correctly across the
// four shapes the Story acceptance criteria enumerate. Each case fails
// closed when the regex regresses and the parser returns `null` for a
// slot whose ID is present in the fixture body.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLinkedIssues } from '../.agents/scripts/lib/issue-link-parser.js';

function planningArtifactsBody(lines) {
  // Mirrors the exact markdown `epic-plan-spec.js` Phase-1 persist
  // emits (line 243), so a regression in either the emitter or the
  // parser surfaces here first.
  const header = '\n\n## Planning Artifacts\n';
  return `${header}${lines.map((l) => `- [ ] ${l}\n`).join('')}`;
}

describe('parseLinkedIssues — Story #2091 contract', () => {
  it('returns all-null slots for a null / undefined / empty body', () => {
    assert.deepEqual(parseLinkedIssues(null), {
      prd: null,
      techSpec: null,
      acceptanceSpec: null,
    });
    assert.deepEqual(parseLinkedIssues(undefined), {
      prd: null,
      techSpec: null,
      acceptanceSpec: null,
    });
    assert.deepEqual(parseLinkedIssues(''), {
      prd: null,
      techSpec: null,
      acceptanceSpec: null,
    });
  });

  it('extracts prd only when only the PRD line is present', () => {
    const body = planningArtifactsBody(['PRD: #1001']);
    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.prd, 1001);
    assert.equal(parsed.techSpec, null);
    assert.equal(parsed.acceptanceSpec, null);
  });

  it('extracts prd + techSpec from the canonical two-line shape', () => {
    const body = planningArtifactsBody([
      'PRD: #2001',
      'Tech Spec: #2002',
    ]);
    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.prd, 2001);
    assert.equal(parsed.techSpec, 2002);
    assert.equal(parsed.acceptanceSpec, null);
  });

  it('extracts all three slots when prd + techSpec + acceptanceSpec are present', () => {
    const body = planningArtifactsBody([
      'PRD: #3001',
      'Tech Spec: #3002',
      'Acceptance Spec: #3003',
    ]);
    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.prd, 3001);
    assert.equal(parsed.techSpec, 3002);
    assert.equal(parsed.acceptanceSpec, 3003);
  });

  it('returns null for every slot when the Planning Artifacts section is empty', () => {
    const body = '\n\n## Planning Artifacts\n';
    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.prd, null);
    assert.equal(parsed.techSpec, null);
    assert.equal(parsed.acceptanceSpec, null);
  });

  it('accepts the alternative spec wordings the parser advertises in its JSDoc', () => {
    // Lower-case, hyphenated, abbreviated — all variants the parser
    // explicitly documents must continue to round-trip.
    const techSpecVariants = [
      'Technical Spec: #5001',
      'tech-spec: #5002',
      'tech spec: #5003',
    ];
    for (const line of techSpecVariants) {
      const parsed = parseLinkedIssues(`- [ ] ${line}\n`);
      assert.match(line, /#(\d+)/);
      const expected = Number.parseInt(line.match(/#(\d+)/)[1], 10);
      assert.equal(parsed.techSpec, expected, `failed: ${line}`);
    }
    const acceptanceVariants = [
      'Acceptance Spec: #6001',
      'acceptance-spec: #6002',
      'accept-spec: #6003',
    ];
    for (const line of acceptanceVariants) {
      const parsed = parseLinkedIssues(`- [ ] ${line}\n`);
      assert.match(line, /#(\d+)/);
      const expected = Number.parseInt(line.match(/#(\d+)/)[1], 10);
      assert.equal(parsed.acceptanceSpec, expected, `failed: ${line}`);
    }
  });
});
