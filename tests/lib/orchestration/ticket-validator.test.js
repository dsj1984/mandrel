import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  _internal,
  validateAndNormalizeTickets,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

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
