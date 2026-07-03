// tests/issue-link-parser.test.js
//
// Lock the parser contract for Story #2091 (updated by Story #4314, which
// retired the PRD artifact class): round-trip a representative Epic body
// through `parseLinkedIssues` and assert each surviving artefact slot
// (`techSpec`, `acceptanceSpec`) populates correctly across the shapes the
// Story acceptance criteria enumerate. Each case fails closed when the regex
// regresses and the parser returns `null` for a slot whose ID is present in
// the fixture body. Historical PRD list items may still appear in a body, but
// the parser no longer surfaces a `prd` slot for them.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseLinkedIssues } from '../.agents/scripts/lib/issue-link-parser.js';

function planningArtifactsBody(lines) {
  // Mirrors the exact markdown `epic-plan-spec.js` Phase-1 persist
  // emits, so a regression in either the emitter or the parser surfaces
  // here first.
  const header = '\n\n## Planning Artifacts\n';
  return `${header}${lines.map((l) => `- [ ] ${l}\n`).join('')}`;
}

describe('parseLinkedIssues — Story #2091 contract (post-#4314 PRD retirement)', () => {
  it('returns all-null slots for a null / undefined / empty body', () => {
    assert.deepEqual(parseLinkedIssues(null), {
      techSpec: null,
      acceptanceSpec: null,
    });
    assert.deepEqual(parseLinkedIssues(undefined), {
      techSpec: null,
      acceptanceSpec: null,
    });
    assert.deepEqual(parseLinkedIssues(''), {
      techSpec: null,
      acceptanceSpec: null,
    });
  });

  it('extracts techSpec only when only the Tech Spec line is present', () => {
    const body = planningArtifactsBody(['Tech Spec: #2002']);
    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.techSpec, 2002);
    assert.equal(parsed.acceptanceSpec, null);
    assert.ok(!('prd' in parsed), 'parser must not surface a prd slot');
  });

  it('extracts techSpec + acceptanceSpec from the canonical two-line shape', () => {
    const body = planningArtifactsBody([
      'Tech Spec: #2002',
      'Acceptance Spec: #2003',
    ]);
    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.techSpec, 2002);
    assert.equal(parsed.acceptanceSpec, 2003);
  });

  it('extracts both surviving slots when a historical PRD line is also present', () => {
    // Forward-only: a legacy body may still carry a `PRD:` list item, but the
    // parser ignores it and surfaces no `prd` key.
    const body = planningArtifactsBody([
      'PRD: #3001',
      'Tech Spec: #3002',
      'Acceptance Spec: #3003',
    ]);
    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.techSpec, 3002);
    assert.equal(parsed.acceptanceSpec, 3003);
    assert.ok(
      !('prd' in parsed),
      'legacy PRD line must not surface a prd slot',
    );
  });

  it('returns null for every slot when the Planning Artifacts section is empty', () => {
    const body = '\n\n## Planning Artifacts\n';
    const parsed = parseLinkedIssues(body);
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
      const parsed = parseLinkedIssues(planningArtifactsBody([line]));
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
      const parsed = parseLinkedIssues(planningArtifactsBody([line]));
      assert.match(line, /#(\d+)/);
      const expected = Number.parseInt(line.match(/#(\d+)/)[1], 10);
      assert.equal(parsed.acceptanceSpec, expected, `failed: ${line}`);
    }
  });

  // Story #3848 — regression guard: prose references in the body must not
  // shadow the canonical Planning Artifacts section links.
  it('ignores prose spec references outside the Planning Artifacts section (Story #3848)', () => {
    // Simulate the live reproduction case: body prose mentions a foreign
    // Epic's Acceptance Spec #907, but the Planning Artifacts section links
    // the correct ticket #1442.
    const body = [
      '## Summary',
      '',
      'Bundled follow-up: AC-8..AC-12 on Acceptance Spec #907 from Epic #11.',
      'Also references Tech Spec #43 in passing prose.',
      '',
      '## Planning Artifacts',
      '- [ ] Tech Spec: #200',
      '- [ ] Acceptance Spec: #1442',
      '',
      '## Other Section',
      'Some more content referencing Acceptance Spec #999.',
    ].join('\n');

    const parsed = parseLinkedIssues(body);

    // Must resolve to the Planning Artifacts values, not the prose values.
    assert.equal(
      parsed.techSpec,
      200,
      'techSpec should be 200 from Planning Artifacts, not 43 from prose',
    );
    assert.equal(
      parsed.acceptanceSpec,
      1442,
      'acceptanceSpec should be 1442 from Planning Artifacts, not 907 from prose',
    );
  });

  it('returns all-null slots when there is no Planning Artifacts section at all', () => {
    // Prose references without a Planning Artifacts section must return null
    // (not the prose value) — plan-epic.js treats null as "not yet linked"
    // and will create fresh tickets rather than linking foreign ones.
    const body = [
      '## Summary',
      '',
      'See Tech Spec #43, Acceptance Spec #907 for prior art.',
    ].join('\n');

    const parsed = parseLinkedIssues(body);
    assert.equal(parsed.techSpec, null);
    assert.equal(parsed.acceptanceSpec, null);
  });
});
