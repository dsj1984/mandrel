/**
 * tests/epic-plan-clarity.test.js — unit tests for the Phase 6 Epic
 * Clarity Gate scoring rubric.
 *
 * Covers:
 *  - All 5 sections present (canonical headings) → clear
 *  - All 5 sections present (legacy ideation-shape headings) → clear
 *  - All 5 sections present (Epic 2173-style technical-Epic headings) → clear
 *  - 4 present but Acceptance Criteria missing → needs-refinement
 *    (Story #3910 — AC is a required section, not one of the optional four)
 *  - 4 present but Acceptance Criteria placeholder → needs-refinement
 *  - 3 present + 2 placeholder → needs-refinement
 *  - Empty body → needs-refinement with all 5 in gap list
 *  - Heading variants per canonical section
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SECTION_NAMES,
  scoreEpicBody,
} from '../.agents/scripts/lib/epic-plan-clarity.js';

const CANONICAL_BODY = `# Foo Epic

## Context

Real users hit X today; the current flow has Y pain.

## Goal

Get users to Z without the Y pain.

## Non-Goals

- W — out of scope.

## Scope

Ship Z narrowly behind a flag.

## Acceptance Criteria

- [ ] A
- [ ] B
`;

const LEGACY_IDEATION_BODY = `# Foo Epic

## Problem Statement

Real users hit X.

## Recommended Direction

Do Y.

## MVP Scope

Ship Y narrowly.

## Not Doing (and Why)

- Z — out of scope.

## Acceptance Criteria

- [ ] A
`;

const TECHNICAL_EPIC_BODY = `# Refactor Epic

## Context

Four overlapping paths do the same thing inconsistently.

## Goal

Unify behind a single service.

## Non-Goals

- Lifecycle restructuring lives in a sibling epic.

## Scope (proposed stories)

1. Unified service + tests
2. Migrate callers

## Acceptance Criteria

1. Single code path enforced by lint rule.
2. Default behaviour matches the unified contract.

## Design

Sketch of the unified service API.

## Migration / Risk

Behavior change at the manual CLI documented in CHANGELOG.

## Out of Scope

Replacing baseline file formats.
`;

describe('scoreEpicBody', () => {
  it('returns clear with all five canonical headings present', () => {
    const result = scoreEpicBody({ body: CANONICAL_BODY });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, []);
    assert.equal(result.sections.length, 5);
    for (const s of result.sections) {
      assert.equal(s.status, 'present', `${s.name} should be present`);
    }
  });

  it('returns clear with legacy ideation-shape headings present', () => {
    const result = scoreEpicBody({ body: LEGACY_IDEATION_BODY });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, []);
  });

  it('returns clear for a technical Epic that uses Context / Goal / Non-Goals / Scope (proposed stories) / Acceptance Criteria', () => {
    const result = scoreEpicBody({ body: TECHNICAL_EPIC_BODY });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, []);
  });

  it('returns needs-refinement when Acceptance Criteria is missing even with the other 4 present (Story #3910 — AC is required)', () => {
    const body = `# Foo

## Context
P

## Goal
G

## Non-Goals
- N

## Scope
M
`;
    const result = scoreEpicBody({ body });
    assert.equal(result.verdict, 'needs-refinement');
    assert.deepEqual(result.missingOrPlaceholder, ['acceptanceCriteria']);
    const ac = result.sections.find((s) => s.name === 'acceptanceCriteria');
    assert.equal(ac.status, 'missing');
  });

  it('returns clear when all 5 present including Acceptance Criteria (AC requirement satisfied)', () => {
    const body = `# Foo

## Context
P

## Goal
G

## Non-Goals
- N

## Scope
M

## Acceptance Criteria
- [ ] A
`;
    const result = scoreEpicBody({ body });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, []);
  });

  it('returns needs-refinement when 4 present but Acceptance Criteria is a placeholder', () => {
    const body = `# Foo

## Context
P

## Goal
G

## Non-Goals
- N

## Scope
M

## Acceptance Criteria
_(not specified)_
`;
    const result = scoreEpicBody({ body });
    assert.equal(result.verdict, 'needs-refinement');
    assert.deepEqual(result.missingOrPlaceholder, ['acceptanceCriteria']);
    const ac = result.sections.find((s) => s.name === 'acceptanceCriteria');
    assert.equal(ac.status, 'placeholder');
  });

  it('returns needs-refinement when 3 present + 2 placeholder', () => {
    const body = `# Foo

## Context
Real context.

## Goal
_(not specified)_

## Non-Goals
- n

## Scope
_(not specified)_

## Acceptance Criteria
- ac
`;
    const result = scoreEpicBody({ body });
    assert.equal(result.verdict, 'needs-refinement');
    assert.equal(result.missingOrPlaceholder.length, 2);
    assert.ok(result.missingOrPlaceholder.includes('goal'));
    assert.ok(result.missingOrPlaceholder.includes('scope'));
    const goal = result.sections.find((s) => s.name === 'goal');
    assert.equal(goal.status, 'placeholder');
    const scope = result.sections.find((s) => s.name === 'scope');
    assert.equal(scope.status, 'placeholder');
  });

  it('returns needs-refinement with all 5 in gap list for empty body', () => {
    const result = scoreEpicBody({ body: '' });
    assert.equal(result.verdict, 'needs-refinement');
    assert.deepEqual(
      [...result.missingOrPlaceholder].sort(),
      [...SECTION_NAMES].sort(),
    );
    for (const s of result.sections) {
      assert.equal(s.status, 'missing');
    }
  });

  it('handles missing body argument as empty (no throw)', () => {
    const result = scoreEpicBody({});
    assert.equal(result.verdict, 'needs-refinement');
    assert.equal(result.missingOrPlaceholder.length, 5);
  });

  it('matches the `## Problem Statement` heading variant for context', () => {
    const body = `## Problem Statement\nfoo\n`;
    const result = scoreEpicBody({ body });
    const context = result.sections.find((s) => s.name === 'context');
    assert.equal(context.status, 'present');
  });

  it('matches the `## Background` heading variant for context', () => {
    const body = `## Background\nfoo\n`;
    const result = scoreEpicBody({ body });
    const context = result.sections.find((s) => s.name === 'context');
    assert.equal(context.status, 'present');
  });

  it('matches the `## Recommended Direction` heading variant for goal', () => {
    const body = `## Recommended Direction\nbar\n`;
    const result = scoreEpicBody({ body });
    const goal = result.sections.find((s) => s.name === 'goal');
    assert.equal(goal.status, 'present');
  });

  it('matches the `## Objectives` heading variant for goal', () => {
    const body = `## Objectives\nbar\n`;
    const result = scoreEpicBody({ body });
    const goal = result.sections.find((s) => s.name === 'goal');
    assert.equal(goal.status, 'present');
  });

  it('matches `## Out of Scope` and `## Not Doing` heading variants for non-goals', () => {
    for (const heading of ['## Out of Scope', '## Not Doing', '## Non Goals']) {
      const body = `${heading}\n- thing\n`;
      const result = scoreEpicBody({ body });
      const nonGoals = result.sections.find((s) => s.name === 'nonGoals');
      assert.equal(
        nonGoals.status,
        'present',
        `${heading} should match nonGoals`,
      );
    }
  });

  it('matches `## MVP Scope` and `## Scope (proposed stories)` for scope', () => {
    for (const heading of [
      '## MVP Scope',
      '## Scope (proposed stories)',
      '## Proposed Scope',
      '## Work Breakdown',
    ]) {
      const body = `${heading}\ncontent\n`;
      const result = scoreEpicBody({ body });
      const scope = result.sections.find((s) => s.name === 'scope');
      assert.equal(scope.status, 'present', `${heading} should match scope`);
    }
  });

  it('matches `## AC` and `## Acceptance` heading variants for acceptance criteria', () => {
    for (const heading of [
      '## AC',
      '## Acceptance',
      '## Acceptance Criteria',
    ]) {
      const body = `${heading}\n- ac\n`;
      const result = scoreEpicBody({ body });
      const ac = result.sections.find((s) => s.name === 'acceptanceCriteria');
      assert.equal(
        ac.status,
        'present',
        `${heading} should match acceptanceCriteria`,
      );
    }
  });

  it('treats whitespace-only section content as placeholder', () => {
    const body = `## Context
\t  \n
## Goal
present text
## Non-Goals
- a
## Scope
m
## Acceptance Criteria
- ac
`;
    const result = scoreEpicBody({ body });
    const context = result.sections.find((s) => s.name === 'context');
    assert.equal(context.status, 'placeholder');
  });
});

// Story #4324 — the Tech Spec and Acceptance Table now fold into the Epic
// body as managed sections. The clarity gate must recognise them
// (reported informationally) WITHOUT letting them perturb the ideation
// verdict: a post-fold Epic body scores exactly as its ideation content
// deserves, never "needs-refinement" because of the folded sections.
describe('scoreEpicBody — folded planning sections (Story #4324)', () => {
  const IDEATION = `## Context
Real context.
## Goal
Real goal.
## Non-Goals
- none
## Scope
Real scope.
## Acceptance Criteria
- [ ] bullet one
`;
  const FOLDED = `${IDEATION}
<!-- mandrel:tech-spec:start -->

## Delivery Slicing
| Slice | What ships | Independent? |
| --- | --- | --- |
| Foundation | core | Yes |

<!-- mandrel:tech-spec:end -->

<!-- mandrel:acceptance-table:start -->

## Acceptance Table
| AC ID | Outcome | Feature File | Scenario | Disposition |
| --- | --- | --- | --- | --- |
| AC-1 | x | f.feature | s | new |

<!-- mandrel:acceptance-table:end -->
`;

  it('a fully-planned post-fold Epic body still scores clear', () => {
    const result = scoreEpicBody({ body: FOLDED });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, []);
  });

  it('reports the folded planning sections informationally', () => {
    const folded = scoreEpicBody({ body: FOLDED });
    assert.deepEqual(folded.planningSections, [
      { name: 'deliverySlicing', status: 'present' },
      { name: 'acceptanceTable', status: 'present' },
    ]);
    const preSpec = scoreEpicBody({ body: IDEATION });
    assert.deepEqual(preSpec.planningSections, [
      { name: 'deliverySlicing', status: 'missing' },
      { name: 'acceptanceTable', status: 'missing' },
    ]);
  });

  it('planning-section presence never rescues a thin ideation body', () => {
    const thin = `## Context
Only context.

## Delivery Slicing
| Slice | What ships | Independent? |

## Acceptance Table
| AC ID | Outcome |
`;
    const result = scoreEpicBody({ body: thin });
    assert.equal(result.verdict, 'needs-refinement');
  });
});
