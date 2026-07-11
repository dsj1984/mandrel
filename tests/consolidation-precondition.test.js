/**
 * Unit spec for the Phase 8.3 consolidation dispatch precondition
 * (Story #4431, Epic #4429).
 *
 * `evaluateConsolidationPrecondition` is the deterministic gate that decides
 * whether the fresh-context `epic-plan-consolidate` sub-agent needs to run
 * at all: when the decomposer draft already matches the Tech Spec's
 * Delivery Slicing table 1:1 (count + dependency shape), dispatch is a
 * no-op and the gate returns `dispatch: false`. Every ambiguous input
 * (missing/unparseable section, unparseable Independent? cell) must fail
 * open to `dispatch: true` so the gate can only ever save a dispatch, never
 * suppress a real divergence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateConsolidationPrecondition,
  parseDeliverySlicingTable,
} from '../.agents/scripts/lib/orchestration/consolidation-precondition.js';

function slicingBody(rows) {
  const header = '| Slice | What ships | Independent? |';
  const sep = '| --- | --- | --- |';
  const body = rows
    .map((r) => `| ${r.slice} | ${r.ships} | ${r.independent} |`)
    .join('\n');
  return `## Goal\n\nSome goal.\n\n## Delivery Slicing\n\n${header}\n${sep}\n${body}\n\n## Architecture & Design\n\nMore text.\n`;
}

function draftStory({ slug, dependsOn = [], goal = 'Implements the slice.' }) {
  return {
    slug,
    title: slug,
    type: 'story',
    depends_on: dependsOn,
    acceptance: ['npm test exits 0'],
    verify: ['npm test (unit)'],
    body: `## Goal\n\n${goal}\n\n## Changes\n\n## Acceptance\n\n- [ ] npm test exits 0\n\n## Verify\n\n- npm test (unit)\n`,
  };
}

describe('parseDeliverySlicingTable', () => {
  it('parses a well-formed table with Yes/No cells', () => {
    const body = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Yes' },
      {
        slice: 'Wiring',
        ships: 'Integration',
        independent: 'No — depends on Foundation',
      },
    ]);
    const rows = parseDeliverySlicingTable(body);
    assert.deepEqual(rows, [
      { slice: 'Foundation', independent: true },
      { slice: 'Wiring', independent: false },
    ]);
  });

  it('is case-insensitive on the leading word', () => {
    const body = slicingBody([{ slice: 'A', ships: 'x', independent: 'YES' }]);
    const rows = parseDeliverySlicingTable(body);
    assert.equal(rows[0].independent, true);
  });

  it('returns null when the heading is absent', () => {
    assert.equal(
      parseDeliverySlicingTable('## Goal\n\nNo slicing here.\n'),
      null,
    );
  });

  it('returns null when the Independent? cell is unparseable', () => {
    const body = slicingBody([
      { slice: 'A', ships: 'x', independent: 'Maybe' },
    ]);
    assert.equal(parseDeliverySlicingTable(body), null);
  });

  it('returns null for an empty/whitespace body', () => {
    assert.equal(parseDeliverySlicingTable(''), null);
    assert.equal(parseDeliverySlicingTable(null), null);
  });

  it('returns null when the table has no "Independent?" column at all', () => {
    const header = '| Slice | What ships |';
    const sep = '| --- | --- |';
    const body =
      '## Goal\n\nSome goal.\n\n## Delivery Slicing\n\n' +
      `${header}\n${sep}\n| Foundation | Base module |\n\n` +
      '## Architecture & Design\n\nMore text.\n';
    assert.equal(parseDeliverySlicingTable(body), null);
  });
});

describe('evaluateConsolidationPrecondition', () => {
  it('returns dispatch:false when the draft matches Delivery Slicing 1:1 in count and dependency shape', () => {
    const epicBody = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Yes' },
      {
        slice: 'Wiring',
        ships: 'Integration',
        independent: 'No (a: consumes Foundation)',
      },
    ]);
    const draftStories = [
      draftStory({ slug: 'foundation', dependsOn: [] }),
      draftStory({ slug: 'wiring', dependsOn: ['foundation'] }),
    ];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, false);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /Draft matches Delivery Slicing 1:1/);
  });

  it('returns dispatch:true with a reason on a story-count divergence', () => {
    const epicBody = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Yes' },
    ]);
    const draftStories = [
      draftStory({ slug: 'foundation' }),
      draftStory({ slug: 'extra' }),
    ];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /Story count diverges/);
  });

  it('returns dispatch:true when depends_on shape contradicts a "No" (dependent) slice', () => {
    const epicBody = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Yes' },
      {
        slice: 'Wiring',
        ships: 'Integration',
        independent: 'No (a: consumes Foundation)',
      },
    ]);
    const draftStories = [
      draftStory({ slug: 'foundation', dependsOn: [] }),
      draftStory({ slug: 'wiring', dependsOn: [] }), // should depend on foundation but doesn't
    ];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.reasons.length, 1);
    assert.match(
      result.reasons[0],
      /Independent: No but draft Story "wiring" declares no depends_on/,
    );
  });

  it('returns dispatch:true when depends_on shape contradicts a "Yes" (independent) slice', () => {
    const epicBody = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Yes' },
      { slice: 'Standalone', ships: 'Separate module', independent: 'Yes' },
    ]);
    const draftStories = [
      draftStory({ slug: 'foundation', dependsOn: [] }),
      draftStory({ slug: 'standalone', dependsOn: ['foundation'] }), // marked independent but depends anyway
    ];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.reasons.length, 1);
    assert.match(
      result.reasons[0],
      /Independent: Yes but draft Story "standalone" declares depends_on/,
    );
  });

  it('fails open (dispatch:true) when the Delivery Slicing section is missing', () => {
    const draftStories = [draftStory({ slug: 'a' })];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody: '## Goal\n\nNo slicing section.\n',
    });
    assert.equal(result.dispatch, true);
    assert.match(result.reasons[0], /missing or unparseable/);
  });

  it('fails open (dispatch:true) when the Delivery Slicing section is unparseable', () => {
    const draftStories = [draftStory({ slug: 'a' })];
    const epicBody = '## Delivery Slicing\n\nNo table here, just prose.\n';
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, true);
    assert.match(result.reasons[0], /missing or unparseable/);
  });

  it('fails open (dispatch:true) when an Independent? cell is unparseable', () => {
    const epicBody = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Unclear' },
    ]);
    const draftStories = [draftStory({ slug: 'foundation' })];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, true);
    assert.match(result.reasons[0], /missing or unparseable/);
  });

  it('fails open (dispatch:true) when the Delivery Slicing table is missing the "Independent?" column entirely', () => {
    const header = '| Slice | What ships |';
    const sep = '| --- | --- |';
    const epicBody =
      '## Goal\n\nSome goal.\n\n## Delivery Slicing\n\n' +
      `${header}\n${sep}\n| Foundation | Base module |\n\n` +
      '## Architecture & Design\n\nMore text.\n';
    const draftStories = [draftStory({ slug: 'foundation' })];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, true);
    assert.match(result.reasons[0], /missing or unparseable/);
  });

  // Pins the current row/Story matching behavior: rows and draft Stories are
  // paired up by array **position**, not by slug/name. Reordering either
  // side relative to the other therefore compares the wrong pairs — this
  // test locks that in as documented, current behavior so a future
  // refactor toward name-based matching shows up as an intentional
  // behavior change here, not a silent regression.
  it('matches Delivery Slicing rows to draft Stories positionally, not by slug', () => {
    const epicBody = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Yes' },
      {
        slice: 'Wiring',
        ships: 'Integration',
        independent: 'No (a: consumes Foundation)',
      },
    ]);
    // Same two Stories as the matching 1:1 case above, but listed in the
    // opposite order from the Delivery Slicing table — "wiring" (which
    // has depends_on) now sits at position 0 (paired against the
    // Independent: Yes "Foundation" row), and "foundation" (no
    // depends_on) sits at position 1 (paired against the Independent: No
    // "Wiring" row).
    const draftStories = [
      draftStory({ slug: 'wiring', dependsOn: ['foundation'] }),
      draftStory({ slug: 'foundation', dependsOn: [] }),
    ];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.reasons.length, 2);
    assert.match(
      result.reasons[0],
      /Slice "Foundation" \(position 1\) is marked Independent: Yes but draft Story "wiring" declares depends_on \[foundation\]\./,
    );
    assert.match(
      result.reasons[1],
      /Slice "Wiring" \(position 2\) is marked Independent: No but draft Story "foundation" declares no depends_on\./,
    );
  });

  it('excludes the wave-0 bdd-scaffold Story from the count comparison', () => {
    const epicBody = slicingBody([
      { slice: 'Foundation', ships: 'Base module', independent: 'Yes' },
      {
        slice: 'Wiring',
        ships: 'Integration',
        independent: 'No (a: consumes Foundation)',
      },
    ]);
    const scaffold = draftStory({
      slug: 'bdd-scaffold-story',
      dependsOn: [],
      goal: 'Scaffold pending BDD scenarios (bdd-scaffold).',
    });
    const draftStories = [
      scaffold,
      draftStory({ slug: 'foundation', dependsOn: [] }),
      draftStory({ slug: 'wiring', dependsOn: ['foundation'] }),
    ];
    const result = evaluateConsolidationPrecondition({
      draftStories,
      epicBody,
    });
    assert.equal(result.dispatch, false);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /Draft matches Delivery Slicing 1:1/);
  });

  it('throws a TypeError when draftStories is not an array', () => {
    assert.throws(
      () =>
        evaluateConsolidationPrecondition({
          draftStories: null,
          epicBody: '## Delivery Slicing\n',
        }),
      TypeError,
    );
  });
});
