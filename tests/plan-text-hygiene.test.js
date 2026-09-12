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
