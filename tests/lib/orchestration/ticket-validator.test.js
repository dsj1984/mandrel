import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateTickets } from '../../../.agents/scripts/lib/orchestration/plan-persist/persist-helpers.js';
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

/**
 * Story #5342 — the inline contract narrowed to `acceptance[]`.
 *
 * An empty `acceptance[]` leaves a Story with no observable criterion and
 * nothing downstream can recover it, so it stays a refusal. An empty
 * `verify[]` only means the deliverer picks the commands — worth saying on
 * the dry-run, never worth a re-authoring round.
 */
describe('ticket-validator: the inline contract (Story #5342)', () => {
  it('REFUSES a Story with an empty acceptance[]', () => {
    const backlog = [{ ...story('s1'), acceptance: [] }];
    assert.throws(
      () => validateAndNormalizeTickets(backlog),
      /lack an inline acceptance contract/,
    );
  });

  it('ACCEPTS a Story with an empty verify[], warning instead', () => {
    const backlog = [{ ...story('s1'), verify: [] }];
    let validated;
    assert.doesNotThrow(() => {
      validated = validateAndNormalizeTickets(backlog);
    });
    assert.equal(
      validated.warnings.filter((w) => /lists no verify\[\] entry/.test(w))
        .length,
      1,
    );
    assert.deepEqual(validated.errors, []);
  });

  it('leaves a Story carrying both halves unwarned', () => {
    const validated = validateAndNormalizeTickets([story('s1')]);
    assert.deepEqual(
      validated.warnings.filter((w) => /verify\[\]/.test(w)),
      [],
    );
  });

  it('no longer scores commit-subject prefixes in acceptance items', () => {
    // The subject-prefix validator and its allowed-types set are gone: the
    // commit-msg hook and normalize-pr-title.js are the enforcement points.
    const backlog = [
      {
        ...story('s1'),
        acceptance: ["Commit subject begins with 'baseline-refresh:'"],
      },
    ];
    assert.doesNotThrow(() => validateAndNormalizeTickets(backlog));
  });
});

describe('ticket-validator: bare-path References entries (Story #5516 AC-4)', () => {
  const AT_BASE = new Set(['src/refs.js', 'docs/read-me.md']);
  const gitRunner = ({ path }) => AT_BASE.has(path);

  function referencing(references, shape) {
    const fields = {
      goal: 'Name the read-first files.',
      changes: [{ path: 'src/refs.js', assumption: 'refactors-existing' }],
      references,
    };
    return {
      slug: 'refs',
      type: 'story',
      title: 'Story refs',
      acceptance: ['refs land'],
      verify: ['npm test'],
      body: shape === 'string' ? serialize(fields) : fields,
    };
  }

  for (const shape of ['object', 'string']) {
    it(`accepts a ${shape} body's bare reference and derives it as a read of an existing path`, () => {
      const story = referencing(['docs/read-me.md'], shape);
      const validated = validateTickets([story], {}, { gitRunner });
      assert.deepEqual(validated.errors, []);
      assert.deepEqual(validated.warnings, []);
      const derived = validated.repairs.filter(
        (r) => r.reason === 'derived-read',
      );
      assert.deepEqual(
        derived.map((r) => [r.path, r.assumption]),
        [['docs/read-me.md', 'exists']],
      );
    });

    it(`warns, never refuses, on a ${shape} body's bare reference absent at base`, () => {
      const story = referencing(['docs/missing.md'], shape);
      let validated;
      assert.doesNotThrow(() => {
        validated = validateTickets([story], {}, { gitRunner });
      });
      assert.deepEqual(validated.errors, []);
      const hits = validated.warnings.filter((w) =>
        w.includes('docs/missing.md'),
      );
      assert.equal(hits.length, 1, JSON.stringify(validated.warnings));
      assert.match(
        hits[0],
        /body\.references names docs\/missing\.md as a read-first file/,
      );
    });
  }

  it('still refuses a References object carrying an unknown assumption', () => {
    const story = referencing(
      [{ path: 'docs/read-me.md', assumption: 'reads' }],
      'object',
    );
    assert.throws(
      () => validateTickets([story], {}, { gitRunner }),
      /body\.references entry must be a bare path or declare/,
    );
  });
});
