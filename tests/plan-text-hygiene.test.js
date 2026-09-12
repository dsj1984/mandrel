/**
 * plan-text-hygiene.test.js — the deterministic text-hygiene lints (Story
 * #4599): the pure evaluator's three finding kinds, and the advisory-only
 * `textHygiene` entry `evaluatePlanCritics` gains alongside the unchanged
 * consolidation / premortem dispatch verdicts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateTextHygiene } from '../.agents/scripts/lib/orchestration/plan-text-hygiene.js';

/** Build a draft Story whose body carries the given Goal/Spec/Slicing text. */
function story({ slug = 's1', goal = 'Ship the change.', spec, slicing } = {}) {
  const sections = [`## Goal\n${goal}`];
  if (slicing !== undefined) sections.push(`## Slicing\n${slicing}`);
  if (spec !== undefined) sections.push(`## Spec\n${spec}`);
  return { slug, depends_on: [], body: `${sections.join('\n\n')}\n` };
}

function kinds(result) {
  return result.findings.map((f) => f.kind);
}

describe('evaluateTextHygiene — open-question', () => {
  it('flags operator-directed open questions in Spec prose', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: [
            'Flag if the intent was to expose them.',
            'The rollout order is TBD.',
            'Confirm with the operator whether the label stays.',
          ].join(' '),
        }),
      ],
    });

    assert.deepEqual(kinds(result), [
      'open-question',
      'open-question',
      'open-question',
    ]);
  });

  it('flags a trailing question mark outside code spans', () => {
    const result = evaluateTextHygiene({
      draftStories: [story({ spec: 'Should the tags also be removed?' })],
    });

    assert.deepEqual(kinds(result), ['open-question']);
  });

  it('does not flag declarative decision-recording prose', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: 'Per operator decision, the tags are removed in this pass.',
        }),
      ],
    });

    assert.deepEqual(kinds(result), []);
  });

  it('ignores question-like text inside code spans', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({ spec: 'Run `grep -c "TBD?" src/x.js` to count markers.' }),
      ],
    });

    assert.deepEqual(kinds(result), []);
  });

  it('ignores operator-directed phrasing inside a fenced code block', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: [
            'The rollout order is recorded below.',
            '',
            '```text',
            'Flag if the intent was to expose them. Should the tags go? TBD',
            '```',
          ].join('\n'),
        }),
      ],
    });

    assert.deepEqual(kinds(result), []);
  });
});

describe('evaluateTextHygiene — input edges', () => {
  it('returns zero findings for a null/absent draft array', () => {
    assert.deepEqual(evaluateTextHygiene({}).findings, []);
    assert.deepEqual(evaluateTextHygiene({ draftStories: null }).findings, []);
  });

  it('skips an unparseable draft body instead of throwing', () => {
    const result = evaluateTextHygiene({
      draftStories: [{ slug: 'bad', body: null }, story({ slug: 'good' })],
    });

    assert.deepEqual(result.findings, []);
  });
});

describe('evaluateTextHygiene — pinned-identifier (Story #5323)', () => {
  /** A draft Story carrying `acceptance` at the ticket's top level. */
  function withAcceptance(acceptance, slug = 's1') {
    return { ...story({ slug }), acceptance };
  }

  it('flags an acceptance item that pins a bare source identifier', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        withAcceptance([
          'The `staffCan` helper refuses an unowned resource.',
          'The `MyCalendarBoard` fixtures render unchanged.',
          'Calling `resolveBaseBranchRef()` returns the configured branch.',
        ]),
      ],
    });

    assert.deepEqual(kinds(result), [
      'pinned-identifier',
      'pinned-identifier',
      'pinned-identifier',
    ]);
    assert.match(result.findings[0].message, /staffCan/);
    assert.match(result.findings[0].message, /observable behaviour/);
    assert.equal(result.findings[0].slug, 's1');
  });

  it('names every pinned identifier in one finding per item', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        withAcceptance([
          'Both `parseVerifyEntry` and `renderChangeRepair` run.',
        ]),
      ],
    });

    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].message, /parseVerifyEntry/);
    assert.match(result.findings[0].message, /renderChangeRepair/);
  });

  it('exempts paths, globs, labels, kebab tokens, flags and commands', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        withAcceptance([
          'A row in `baselines/crap.json` is refreshed.',
          'Every `tests/**/*.spec.ts` file still matches.',
          'The `story-body.js` round-trip holds.',
          'The label `agent::ready` is applied last.',
          'The `data-testid` `availability-chip-set` is preserved.',
          'Running `npm run lint` exits 0.',
          'The `--dry-run` flag suppresses every write.',
          'The key `delivery.routing.closeAndLand` defaults true.',
          'The envelope reports `acceptance[]` unchanged.',
        ]),
      ],
    });

    assert.deepEqual(result.findings, []);
  });

  it('exempts an UPPER_SNAKE token — an env var and a constant are one shape', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        withAcceptance([
          'The `DATABASE_URL` env var is read at the edge.',
          'The ceiling `MAX_WRITE_SLOTS` refuses the request.',
        ]),
      ],
    });

    assert.deepEqual(result.findings, []);
  });

  it('exempts a prose word with no case transition', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        withAcceptance([
          'The envelope reports `landed` once the PR merges.',
          'A `pending` status is resumable, never a failure.',
          'The branch is seeded from `main`.',
          'A coach certified for `Camps` is offered it once.',
        ]),
      ],
    });

    assert.deepEqual(result.findings, []);
  });

  it('reads acceptance off a structured body when the top level carries none', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        {
          slug: 's2',
          body: {
            goal: 'Ship the change.',
            acceptance: ['The `deriveStoryShape` call is unchanged.'],
          },
        },
      ],
    });

    assert.deepEqual(kinds(result), ['pinned-identifier']);
    assert.equal(result.findings[0].slug, 's2');
  });

  it('is silent on a draft with no acceptance at all', () => {
    assert.deepEqual(
      evaluateTextHygiene({ draftStories: [story({ slug: 's3' })] }).findings,
      [],
    );
  });
});
