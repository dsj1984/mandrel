// tests/lib/templates/decomposer-prompts.test.js
//
// Unit tier: prompt-conformance for the story-author system prompt.
//
// Story #5312 (AC-2) renders the prompt from the draft's Story count: the N=1
// core carries the body schema, the contract-level Spec rule and acceptance
// defined as outcomes a PR reviewer can confirm; the schedule rules render
// only for a multi-Story draft. Story #5332 deleted the three-to-six
// acceptance band, the reviewer-sized-PR size anchor, the parallelizable-work
// split bullet and the risk-isolation split criterion, and replaced the
// acceptance partition with the dispatcher's own collision refusal. The retired directives — the
// delivery-schedule simulation, hot-file rule, justification letters, the
// BDD scaffold Story, the scope-overlap note, the reviewability budget, the
// `Current state (verified <date>)` preamble, the intent-then-proxy rule and
// the verify tier suffix — must be absent from the core. Also pins the
// one-shot authoring surface (Story #4707 AC-5): the prompt names the
// structured-object body shape and the emitted stories template.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  renderStoriesTemplate,
  STORIES_TEMPLATE_FILENAME,
} from '../../../.agents/scripts/lib/orchestration/plan-context.js';
import { parse as parseStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';
import {
  renderStoryAuthorCore,
  renderStoryAuthorPrompt,
  renderStorySplitRules,
  ticketsModePromptField,
} from '../../../.agents/scripts/lib/templates/decomposer-prompts.js';

/** AC-2: the strings the N=1 core must not carry. */
const RETIRED_CORE_STRINGS = [
  'parallelism yield',
  'Hot-file rule',
  'justification letter',
  'bdd-scaffold',
  'Scope verification note',
  'REVIEWABILITY BUDGET',
  'Current state (verified',
  'Intent-then-proxy',
  '(<tier>)',
];

describe('story-author prompt — the N=1 core (Story #5312 AC-2)', () => {
  const prompt = renderStoryAuthorPrompt({ storyCount: 1 });

  test('is the core alone — byte-identical to renderStoryAuthorCore()', () => {
    assert.equal(prompt, renderStoryAuthorCore());
    assert.equal(renderStoryAuthorPrompt(), prompt, 'storyCount defaults to 1');
  });

  test('carries none of the retired directive strings', () => {
    for (const retired of RETIRED_CORE_STRINGS) {
      assert.ok(
        !prompt.includes(retired),
        `core prompt must not contain ${JSON.stringify(retired)}`,
      );
    }
    assert.doesNotMatch(prompt, /reason_to_exist/);
    assert.doesNotMatch(prompt, /`wide`/);
    assert.doesNotMatch(prompt, /manual:<reason>/);
    assert.doesNotMatch(prompt, /maxTickets/);
    assert.doesNotMatch(prompt, /DEFAULT_MODEL_CAPACITY/);
  });

  test('defines acceptance as outcomes a PR reviewer can confirm, with no count band (Story #5332 AC-1)', () => {
    assert.match(
      prompt,
      /outcome a PR reviewer can confirm from the diff and the verify output/,
    );
    assert.match(prompt, /\*\*verify\*\*.*mechanical checks/);
    // No target, floor or ceiling on the acceptance list, and a long list is
    // never offered as a reason to split.
    assert.doesNotMatch(prompt, /three to six/);
    assert.match(prompt, /no target, floor or ceiling/);
    assert.match(prompt, /never a reason to split the Story/);
  });

  test('anchors sizing on cohesion, not a reviewer-sized PR (Story #5332 AC-2)', () => {
    assert.doesNotMatch(prompt, /single PR/);
    assert.doesNotMatch(prompt, /probably two Stories/);
    assert.doesNotMatch(prompt, /parallelizable work/i);
    assert.match(prompt, /STORY SIZING — COHESION, NOT COUNT/);
    assert.match(prompt, /A remediation sweep over one subsystem is one Story/);
  });

  test('states what a Slicing checkpoint is and how it differs from acceptance (AC-3)', () => {
    assert.match(prompt, /A checkpoint is a \*\*stage of the work\*\*/);
    assert.match(
      prompt,
      /An acceptance item is a \*\*state of the codebase\*\*/,
    );
  });

  test('carries the body schema and the contract-level Spec rule, without per-file paragraphs', () => {
    assert.match(prompt, /STORY BODY SCHEMA/);
    assert.match(prompt, /## Goal/);
    assert.match(prompt, /## Changes/);
    assert.match(prompt, /SPEC PROSE CONTRACT/);
    assert.match(prompt, /Spec states the contract and invariants/i);
    assert.match(prompt, /Implementation choices belong to the deliverer/i);
    assert.match(prompt, /No per-file behavior paragraphs/i);
    assert.match(prompt, /No current-state narration/i);
    assert.match(prompt, /Do not author a `## References` section/i);
    assert.match(prompt, /Acceptance criteria remain the binding contract/i);
    assert.ok(!prompt.includes('## References\n    - {"path"'));
  });

  test('carries no schedule or partition rules', () => {
    assert.doesNotMatch(prompt, /MULTI-STORY DRAFT/);
    assert.doesNotMatch(prompt, /THE COLLISION REFUSAL/);
    assert.doesNotMatch(prompt, /wave schedule/);
  });

  test('keeps the decisions-not-questions rule with the AFK / HITL unknown triage', () => {
    assert.match(prompt, /record decisions, never questions to the operator/i);
    assert.match(
      prompt,
      /AFK-shaped unknown.+MUST be resolved by your own research/i,
    );
    assert.match(prompt, /only a HITL-shaped unknown.+may be restated/i);
    assert.match(prompt, /decision-made-by-default/i);
  });
});

describe('story-author prompt — the N>1 rules (Story #5312 AC-2)', () => {
  const prompt = renderStoryAuthorPrompt({ storyCount: 2 });

  test('a two-Story draft carries the schedule rules and the collision refusal', () => {
    assert.ok(prompt.startsWith(renderStoryAuthorCore()));
    assert.ok(prompt.endsWith(renderStorySplitRules()));
    assert.match(prompt, /MULTI-STORY DRAFT/);
    assert.match(prompt, /Build the wave schedule/);
    assert.match(prompt, /Every Story must earn its slot/);
    assert.match(prompt, /merges into its consumer/);
    assert.match(prompt, /THE COLLISION REFUSAL/);
    assert.match(prompt, /before it creates a single issue/);
    assert.match(prompt, /depends_on/);
  });

  test('the acceptance partition and the risk-isolation criterion are gone (AC-2, AC-5)', () => {
    assert.doesNotMatch(prompt, /ACCEPTANCE PARTITION/);
    assert.doesNotMatch(prompt, /belongs to \*\*exactly one\*\* Story/);
    assert.doesNotMatch(prompt, /risk isolation/i);
  });

  test('the split rules still carry none of the retired strings', () => {
    for (const retired of RETIRED_CORE_STRINGS) {
      assert.ok(
        !prompt.includes(retired),
        `two-Story prompt must not contain ${JSON.stringify(retired)}`,
      );
    }
  });
});

describe('story-author prompt — one-shot authoring surface (AC-5)', () => {
  const prompt = renderStoryAuthorCore();

  test('body accepts the structured-object shape; persist serializes canonically', () => {
    assert.match(prompt, /structured object/i);
    assert.match(prompt, /serializes the canonical markdown itself/i);
    assert.match(prompt, /never need to read `story-body\.js`/i);
  });

  test('the prompt names the emitted ready-to-fill template file', () => {
    assert.ok(prompt.includes(STORIES_TEMPLATE_FILENAME));
  });

  test('names the changes[] repair and the demoted footprint probes', () => {
    assert.match(
      prompt,
      /repairs a plain-string bullet or a trailing parenthetical/,
    );
    assert.match(prompt, /only a `deletes` naming an absent path is refused/);
  });
});

describe('story-author prompt — orders only output the parser accepts (#5005)', () => {
  const prompt = renderStoryAuthorCore();

  test('the testid-invariance rule targets acceptance[] / Non-Goals, never changes[]', () => {
    const section = prompt.slice(
      prompt.indexOf('#### UI / TESTID INVARIANCE'),
      prompt.indexOf('#### BRAND / COPY / STYLE WORK'),
    );
    assert.ok(section.length > 0, 'the invariance section must still exist');
    assert.match(section, /top-level `acceptance\[\]` item/);
    assert.match(section, /`## Non-Goals` prose/);
    assert.doesNotMatch(section, /MUST end `changes`/);
    assert.match(
      section,
      /Every `changes\[\]` entry is a `\{ path, assumption \}` object/,
    );
  });

  test('no Epic Acceptance Table reference survives anywhere in the prompt', () => {
    assert.doesNotMatch(prompt, /Acceptance Table/i);
    assert.doesNotMatch(prompt, /Epic body/i);
  });
});

describe('renderStoriesTemplate — ready-to-fill authoring skeleton (AC-5)', () => {
  test('renders valid JSON: one Story with the machine-contract fields', () => {
    const parsed = JSON.parse(renderStoriesTemplate());
    assert.ok(Array.isArray(parsed) && parsed.length === 1);
    const [story] = parsed;
    assert.equal(story.type, 'story');
    for (const field of ['slug', 'title', 'body', 'acceptance', 'verify']) {
      assert.ok(field in story, `template must carry ${field}`);
    }
    assert.ok(Array.isArray(story.acceptance) && story.acceptance.length > 0);
    assert.ok(Array.isArray(story.verify) && story.verify.length > 0);
    assert.ok(Array.isArray(story.depends_on));
  });

  test('the structured-object body parses through the canonical story-body parser', () => {
    const [story] = JSON.parse(renderStoriesTemplate());
    assert.equal(typeof story.body, 'object');
    const { body } = parseStoryBody(story.body);
    assert.ok(body.goal.length > 0);
    assert.ok(Array.isArray(body.changes) && body.changes.length === 1);
    assert.equal(body.changes[0].assumption, 'refactors-existing');
    assert.equal('reason_to_exist' in story.body, false);
  });

  test('the template Spec placeholder restates the prose contract, not implementation prose', () => {
    const [story] = JSON.parse(renderStoriesTemplate());
    assert.match(story.body.spec, /contract and invariants only/i);
    assert.match(story.body.spec, /belong to the deliverer/i);
    assert.doesNotMatch(story.body.spec, /250 words|350/);
  });

  test('the verify placeholder carries no tier tag and the acceptance one names the reviewer outcome', () => {
    const [story] = JSON.parse(renderStoriesTemplate());
    assert.doesNotMatch(
      story.verify[0],
      /\((?:unit|contract|e2e|validate)\)\s*$/,
    );
    assert.match(story.acceptance[0], /PR reviewer can confirm/);
    assert.doesNotMatch(story.acceptance[0], /three to six/);
    assert.match(story.acceptance[0], /no target and no ceiling/);
  });

  test('the template carries a filled, multi-checkpoint ## Slicing example (AC-3)', () => {
    const [story] = JSON.parse(renderStoriesTemplate());
    const { body } = parseStoryBody(story.body);
    const checkpoints = body.slicing
      .split('\n')
      .filter((line) => /^\d+\.\s+\S/.test(line.trim()));
    assert.ok(
      checkpoints.length >= 3,
      `template ## Slicing must show multiple checkpoints, got ${checkpoints.length}`,
    );
    assert.doesNotMatch(body.slicing, /^Fill:/im);
  });

  test('deterministic — two renders are byte-identical', () => {
    assert.equal(renderStoriesTemplate(), renderStoriesTemplate());
  });
});

describe('tickets-mode addendum (Story #5323)', () => {
  test('binds the author to re-derive acceptance rather than carry it', () => {
    const rules = ticketsModePromptField('tickets').storyTicketsRules;
    assert.match(rules, /TICKETS-MODE DRAFT/);
    assert.match(rules, /evidence, not a template/i);
    // Re-derive, never carry the handles.
    assert.match(rules, /Re-derive .*acceptance/i);
    assert.match(rules, /AC-<n>/);
    // Mechanical checks belong in verify[].
    assert.match(rules, /mechanical check is a .*verify\[\]. command/i);
    // The tier suffix is named as something to drop, not to reproduce.
    assert.match(rules, /drop any trailing tier suffix/i);
  });

  test('is a separate layer — the N=1 core carries none of it', () => {
    const core = renderStoryAuthorCore();
    assert.doesNotMatch(core, /TICKETS-MODE DRAFT/);
    // And composing by story count never pulls it in: the addendum is
    // selected by mode, not by N.
    assert.doesNotMatch(
      renderStoryAuthorPrompt({ storyCount: 1 }),
      /TICKETS-MODE DRAFT/,
    );
    assert.doesNotMatch(
      renderStoryAuthorPrompt({ storyCount: 3 }),
      /TICKETS-MODE DRAFT/,
    );
  });

  test('the core tells every author to omit generated artifacts from changes[]', () => {
    const core = renderStoryAuthorCore();
    assert.match(core, /omit generated artifacts/i);
    assert.match(core, /baselines/i);
    assert.match(core, /serializes sibling Stories at dispatch/i);
  });
});
