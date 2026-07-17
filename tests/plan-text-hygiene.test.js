/**
 * plan-text-hygiene.test.js — the deterministic text-hygiene lints (Story
 * #4599): the pure evaluator's three finding kinds, and the advisory-only
 * `textHygiene` entry `evaluatePlanCritics` gains alongside the unchanged
 * consolidation / premortem dispatch verdicts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getLimits } from '../.agents/scripts/lib/config-resolver.js';
import {
  evaluateConsolidationDispatch,
  evaluatePremortemDispatch,
} from '../.agents/scripts/lib/orchestration/plan-critic-conditions.js';
import { evaluatePlanCritics } from '../.agents/scripts/lib/orchestration/plan-critics-evaluate.js';
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

describe('evaluateTextHygiene — dangling-citation', () => {
  it('flags a document-section citation with no path and no issue anchor', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: 'Per the design note (§4, Q5), the gate is dead today.',
        }),
      ],
    });

    assert.deepEqual(kinds(result), ['dangling-citation']);
    assert.equal(result.findings[0].slug, 's1');
    assert.match(result.findings[0].evidence, /design note \(§4, Q5\)/);
  });

  it('flags a "review doc" reference with no locating anchor', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({ spec: 'See the review doc §3 for the failure taxonomy.' }),
      ],
    });

    assert.deepEqual(kinds(result), ['dangling-citation']);
  });

  it('does not flag a citation anchored by an issue number in the same sentence', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: 'Per the #4521 design note (§4, Q5), the gate is dead today.',
        }),
      ],
    });

    assert.deepEqual(kinds(result), []);
  });

  it('does not flag a citation anchored by a repo-relative path', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: 'The design note §4 lives at docs/architecture.md today.',
        }),
      ],
    });

    assert.deepEqual(kinds(result), []);
  });
});

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
});

describe('evaluateTextHygiene — slicing-mass', () => {
  it('flags a Slicing section outweighing its Spec', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: 'Small spec.',
          slicing: [
            '1. First checkpoint with a long restatement of the whole design.',
            '2. Second checkpoint that re-covers the Spec detail again at length.',
          ].join('\n'),
        }),
      ],
    });

    assert.deepEqual(kinds(result), ['slicing-mass']);
    assert.match(result.findings[0].message, /outweighs/);
  });

  it('does not flag one-line checkpoints under a heavier Spec', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({
          spec: 'A substantially longer technical approach paragraph that carries the actual implementation detail for both checkpoints below.',
          slicing: '1. Evaluator module.\n2. Workflow wiring.',
        }),
      ],
    });

    assert.deepEqual(kinds(result), []);
  });

  it('does not fire when either section is absent', () => {
    const result = evaluateTextHygiene({
      draftStories: [
        story({ slicing: '1. A very long slicing table with no spec at all.' }),
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

describe('evaluatePlanCritics — advisory textHygiene entry (Story #4599)', () => {
  const draft = [
    story({
      slug: 'cited',
      spec: 'Per the design note (§4, Q5), the gate is dead today.',
    }),
  ];
  const techSpecContent = '## Delivery Slicing\n\n| Slice |\n| --- |\n';

  it('returns textHygiene alongside consolidation and premortem, with kind + evidence per finding', () => {
    const verdict = evaluatePlanCritics({
      techSpecContent,
      tickets: draft,
      config: {},
    });

    assert.deepEqual(Object.keys(verdict), [
      'consolidation',
      'premortem',
      'textHygiene',
    ]);
    assert.equal(verdict.textHygiene.critic, 'text-hygiene');
    assert.ok(Array.isArray(verdict.textHygiene.findings));
    assert.ok(verdict.textHygiene.findings.length > 0);
    for (const finding of verdict.textHygiene.findings) {
      assert.equal(typeof finding.kind, 'string');
      assert.equal(typeof finding.evidence, 'string');
      assert.ok(finding.evidence.length > 0);
    }
    // No dispatch semantics: the entry routes prose, not a sub-agent spawn.
    assert.equal('dispatch' in verdict.textHygiene, false);
  });

  it('leaves the consolidation and premortem dispatch verdicts byte-identical', () => {
    const config = {};
    const verdict = evaluatePlanCritics({
      techSpecContent,
      tickets: draft,
      config,
    });

    // The pre-#4599 composition, reconstructed from the condition functions.
    const expected = {
      consolidation: evaluateConsolidationDispatch({
        draftStories: draft,
        specText: techSpecContent,
      }),
      premortem: evaluatePremortemDispatch({
        ticketCount: draft.length,
        maxTickets: getLimits(config).maxTickets,
        riskHeuristics: [],
        planText: [techSpecContent, JSON.stringify(draft)].join('\n'),
      }),
    };

    assert.equal(
      JSON.stringify({
        consolidation: verdict.consolidation,
        premortem: verdict.premortem,
      }),
      JSON.stringify(expected),
    );
  });
});
