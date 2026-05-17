/**
 * tests/epic-plan-clarity.test.js — unit tests for the Phase 6 Epic
 * Clarity Gate scoring rubric.
 *
 * Covers:
 *  - All 5 sections present (ideation-style long headings) → clear
 *  - All 5 sections present (template-style short headings) → clear
 *  - 4 present + 1 missing → clear (threshold ≥ 4 of 5)
 *  - 3 present + 2 placeholder → needs-refinement
 *  - Empty body → needs-refinement with all 5 in gap list
 *  - Heading variants: `## Problem Statement`, `## Recommended Direction`
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SECTION_NAMES,
  scoreEpicBody,
} from '../.agents/scripts/lib/epic-plan-clarity.js';

const LONG_HEADINGS_BODY = `# Foo Epic

## Problem Statement

Real users hit X.

## Recommended Direction

Do Y.

## Key Assumptions to Validate

- A
- B

## MVP Scope

Ship Y narrowly.

## Not Doing (and Why)

- Z — out of scope.
`;

const SHORT_HEADINGS_BODY = `# Foo Epic

## Problem

Real users hit X.

## Direction

Do Y.

## Assumptions

- A
- B

## MVP Scope

Ship Y narrowly.

## Not Doing

- Z — out of scope.
`;

describe('scoreEpicBody', () => {
  it('returns clear with all five long-form ideation headings present', () => {
    const result = scoreEpicBody({ body: LONG_HEADINGS_BODY });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, []);
    assert.equal(result.sections.length, 5);
    for (const s of result.sections) {
      assert.equal(s.status, 'present', `${s.name} should be present`);
    }
  });

  it('returns clear with all five short-form template headings present', () => {
    const result = scoreEpicBody({ body: SHORT_HEADINGS_BODY });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, []);
  });

  it('returns clear when 4 of 5 sections are present (Not Doing missing)', () => {
    const body = `# Foo

## Problem
P

## Direction
D

## Assumptions
A

## MVP Scope
M
`;
    const result = scoreEpicBody({ body });
    assert.equal(result.verdict, 'clear');
    assert.deepEqual(result.missingOrPlaceholder, ['notDoing']);
    const notDoing = result.sections.find((s) => s.name === 'notDoing');
    assert.equal(notDoing.status, 'missing');
  });

  it('returns needs-refinement when 3 present + 2 placeholder', () => {
    const body = `# Foo

## Problem
Real problem.

## Direction
_(not specified)_

## Assumptions
- a

## MVP Scope
_(not specified)_

## Not Doing
- z
`;
    const result = scoreEpicBody({ body });
    assert.equal(result.verdict, 'needs-refinement');
    assert.equal(result.missingOrPlaceholder.length, 2);
    assert.ok(result.missingOrPlaceholder.includes('direction'));
    assert.ok(result.missingOrPlaceholder.includes('mvpScope'));
    const direction = result.sections.find((s) => s.name === 'direction');
    assert.equal(direction.status, 'placeholder');
    const mvp = result.sections.find((s) => s.name === 'mvpScope');
    assert.equal(mvp.status, 'placeholder');
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

  it('matches the `## Problem Statement` heading variant', () => {
    const body = `## Problem Statement\nfoo\n`;
    const result = scoreEpicBody({ body });
    const problem = result.sections.find((s) => s.name === 'problem');
    assert.equal(problem.status, 'present');
  });

  it('matches the `## Recommended Direction` heading variant', () => {
    const body = `## Recommended Direction\nbar\n`;
    const result = scoreEpicBody({ body });
    const direction = result.sections.find((s) => s.name === 'direction');
    assert.equal(direction.status, 'present');
  });

  it('treats whitespace-only section content as placeholder', () => {
    const body = `## Problem
\t  \n
## Direction
present text
## Assumptions
- a
## MVP Scope
m
## Not Doing
n
`;
    const result = scoreEpicBody({ body });
    const problem = result.sections.find((s) => s.name === 'problem');
    assert.equal(problem.status, 'placeholder');
  });
});
