import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  _internal,
  validateAndNormalizeTickets,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import { serialize } from '../../../.agents/scripts/lib/story-body/story-body.js';

/**
 * Stories-only backlog invariant (Story #4041).
 *
 * `assertAllTicketsAreStories` is a deterministic, HARD invariant under the
 * 2-tier hierarchy (Epic → Story): every ticket the decomposer emits must
 * be `type: "story"` and at least one Story must be present. Any other type
 * (the retired `feature` / `task` tiers, or planner hallucinations) rejects
 * the decomposition with a throw that names the offending tickets.
 *
 * Every Story carries its top-level inline contract (`acceptance[]` +
 * `verify[]`) plus a structured body.
 */

function story(slug, title = `Story ${slug}`) {
  return {
    slug,
    type: 'story',
    title,
    acceptance: [`${title} is implemented`],
    verify: ['npm test (unit)'],
    body: {
      goal: `Goal for ${slug}.`,
      changes: [`src/${slug}.js: edit`],
      acceptance: [`${title} is implemented`],
      verify: ['npm test (unit)'],
    },
  };
}

describe('ticket-validator: Stories-only backlog (Story #4041)', () => {
  it('PASSES a backlog containing only Stories', () => {
    const backlog = [story('s1'), story('s2')];
    assert.doesNotThrow(() => validateAndNormalizeTickets(backlog));
  });

  it('REJECTS a backlog carrying a retired Feature ticket', () => {
    const backlog = [
      { slug: 'f1', type: 'feature', title: 'Retired Feature' },
      story('s1'),
      story('s2'),
    ];
    assert.throws(
      () => validateAndNormalizeTickets(backlog),
      /are not Stories/,
    );
  });

  it('REJECTS a backlog carrying a retired Task ticket', () => {
    const backlog = [
      story('s1'),
      { slug: 't1', type: 'task', title: 'Retired Task' },
    ];
    assert.throws(
      () => validateAndNormalizeTickets(backlog),
      /are not Stories/,
    );
  });

  it('names every offending non-Story ticket with slug and type', () => {
    const backlog = [
      { slug: 'f-a', type: 'feature', title: 'Feature A' },
      { slug: 't-b', type: 'task', title: 'Task B' },
      story('s1'),
    ];
    let caught;
    try {
      validateAndNormalizeTickets(backlog);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected a throw');
    assert.match(caught.message, /2 ticket\(s\) are not Stories/);
    assert.match(caught.message, /"Feature A" \(f-a, type: feature\)/);
    assert.match(caught.message, /"Task B" \(t-b, type: task\)/);
    assert.match(caught.message, /admits type "story" only/);
  });

  it('REJECTS an empty backlog (at least one Story required)', () => {
    assert.throws(() => validateAndNormalizeTickets([]), /at least one Story/);
  });
});

describe('assertAllTicketsAreStories unit (Story #4041)', () => {
  const { assertAllTicketsAreStories } = _internal;

  it('throws when a non-Story ticket is present', () => {
    const tickets = [{ slug: 'f1', type: 'feature', title: 'F' }, story('s1')];
    assert.throws(
      () =>
        assertAllTicketsAreStories({
          tickets,
          stories: tickets.filter((t) => t.type === 'story'),
        }),
      /are not Stories/,
    );
  });

  it('throws when the backlog has zero Stories', () => {
    assert.throws(
      () => assertAllTicketsAreStories({ tickets: [], stories: [] }),
      /at least one Story/,
    );
  });

  it('does not throw on a Stories-only backlog', () => {
    const tickets = [story('s1'), story('s2')];
    assert.doesNotThrow(() =>
      assertAllTicketsAreStories({ tickets, stories: tickets }),
    );
  });
});

/**
 * Soft `## Spec` word-budget pass (Story #4723, AC-3): an over-budget Spec
 * produces an advisory `'soft'` finding and NEVER an error — the persist
 * proceeds. An under-budget Spec produces no finding at all.
 */

/**
 * Optional per-Story `provenance` shape gate (Story #5045).
 *
 * The field decides which audit identities persist stamps into a Story body.
 * A malformed entry must fail here rather than at the stamper: past assembly,
 * a dropped identity is indistinguishable from a Story that legitimately owns
 * nothing, and the cost lands a whole sweep later when the next audit re-files
 * work this plan already tracked.
 */
describe('ticket-validator: per-Story provenance shape (Story #5045)', () => {
  const SHA = 'a'.repeat(40);

  function withProvenance(provenance) {
    return { ...story('owns-a-finding'), provenance };
  }

  it('accepts a well-formed provenance field', () => {
    const validated = validateAndNormalizeTickets([
      withProvenance({
        fingerprints: [SHA],
        semanticKeys: ['architecture␟lib/owned.js'],
      }),
    ]);
    assert.equal(validated.length, 1);
  });

  it('accepts an absent field — the union fallback is the recall-safe default', () => {
    assert.equal(
      validateAndNormalizeTickets([story('no-provenance')]).length,
      1,
    );
  });

  it('rejects a malformed field and names the offending Story', () => {
    assert.throws(
      () =>
        validateAndNormalizeTickets([
          withProvenance({ fingerprints: ['nope'] }),
        ]),
      /Cross-Validation Failed:.*provenance on "owns-a-finding"/s,
    );
  });

  it('batches every offender in one pass', () => {
    assert.throws(
      () =>
        validateAndNormalizeTickets([
          { ...story('bad-one'), provenance: { fingerprints: 'not-an-array' } },
          {
            ...story('bad-two'),
            provenance: { semanticKeys: ['has,a,comma'] },
          },
        ]),
      /2 Story provenance field\(s\) are malformed/,
    );
  });

  it('the assertion is reachable through _internal for a targeted check', () => {
    assert.throws(
      () =>
        _internal.assertStoryProvenanceShape({
          stories: [{ slug: 'direct', provenance: { unknownKey: [] } }],
        }),
      /unknown field: unknownKey/,
    );
  });
});

describe('ticket-validator: external `#<id>` depends_on refs (Story #5155)', () => {
  it('ACCEPTS a `#<id>` ref that matches no sibling slug', () => {
    // The unknown-slug guard is what would otherwise reject every cross-plan
    // edge: `#4712` names a live issue, and by construction no slug in this
    // backlog will ever equal it.
    const backlog = [{ ...story('s1'), depends_on: ['#4712'] }, story('s2')];
    assert.doesNotThrow(() => validateAndNormalizeTickets(backlog));
  });

  it('still REJECTS a genuine unknown sibling slug alongside an external ref', () => {
    const backlog = [
      { ...story('s1'), depends_on: ['#4712', 'typo-slug'] },
      story('s2'),
    ];
    assert.throws(
      () => validateAndNormalizeTickets(backlog),
      /unknown slugs: .*typo-slug/,
    );
  });

  it('excludes external refs from cycle detection', () => {
    // Two Stories each waiting on the same live blocker is not a cycle; only
    // an edge between nodes IN this run can close one.
    const backlog = [
      { ...story('s1'), depends_on: ['#4712'] },
      { ...story('s2'), depends_on: ['#4712', 's1'] },
    ];
    assert.doesNotThrow(() => validateAndNormalizeTickets(backlog));
  });

  it('still detects a real cycle between siblings', () => {
    const backlog = [
      { ...story('s1'), depends_on: ['s2'] },
      { ...story('s2'), depends_on: ['#4712', 's1'] },
    ];
    assert.throws(
      () => validateAndNormalizeTickets(backlog),
      /Circular dependency/,
    );
  });
});
