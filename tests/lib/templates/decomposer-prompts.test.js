// tests/lib/templates/decomposer-prompts.test.js
//
// Unit tier (Story #4707 AC-6): prompt-conformance for the story-author
// system prompt. The intent is that generated Story prose states the
// contract rather than the implementation; the proxy is asserting the SPEC
// PROSE CONTRACT directives are literally present in the rendered prompt —
// contract-and-invariants Spec, deliverer-owned implementation choices,
// no per-file behavior paragraphs, no current-state narration, no
// `## References` section, and acceptance criteria staying the binding
// contract. Also pins the one-shot authoring surface (Story #4707 AC-5):
// the prompt names the structured-object body shape and the emitted
// stories template, so no documented authoring step requires reading
// `story-body.js` source.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  renderStoriesTemplate,
  STORIES_TEMPLATE_FILENAME,
} from '../../../.agents/scripts/lib/orchestration/plan-context.js';
import { parse as parseStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';
import { renderDecomposerSystemPrompt } from '../../../.agents/scripts/lib/templates/decomposer-prompts.js';

describe('story-author prompt — SPEC PROSE CONTRACT directives (AC-6)', () => {
  const prompt = renderDecomposerSystemPrompt();

  test('the prose-contract section is present', () => {
    assert.match(prompt, /SPEC PROSE CONTRACT/);
  });

  test('Spec states contract and invariants with their why', () => {
    assert.match(prompt, /Spec states the contract and invariants/i);
    assert.match(
      prompt,
      /interfaces, status codes, security invariants, and load-bearing constraints/i,
    );
  });

  test('implementation choices belong to the deliverer unless load-bearing', () => {
    assert.match(prompt, /Implementation choices belong to the deliverer/i);
    assert.match(prompt, /load-bearing choice is stated as a constraint/i);
  });

  test('no per-file behavior paragraphs and no current-state narration', () => {
    assert.match(prompt, /No per-file behavior paragraphs/i);
    assert.match(prompt, /No current-state narration/i);
  });

  test('directs against authoring a ## References section', () => {
    assert.match(prompt, /Do not author a `## References` section/i);
    // The serialized-section skeleton no longer advertises the section either
    // (a skeleton that renders it would contradict the directive) — assert
    // on the exact skeleton line shape so the SCOPE-OVERLAP prose (which
    // legitimately uses the word) does not mask a regression.
    assert.ok(!prompt.includes('## References\n    - {"path"'));
  });

  test('acceptance criteria remain the binding contract', () => {
    assert.match(prompt, /Acceptance criteria remain the binding contract/i);
  });
});

describe('story-author prompt — one-shot authoring surface (AC-5)', () => {
  const prompt = renderDecomposerSystemPrompt();

  test('body accepts the structured-object shape; persist serializes canonically', () => {
    assert.match(prompt, /structured object/i);
    assert.match(prompt, /serializes the canonical markdown itself/i);
    assert.match(prompt, /never need to read `story-body\.js`/i);
  });

  test('the prompt names the emitted ready-to-fill template file', () => {
    assert.ok(prompt.includes(STORIES_TEMPLATE_FILENAME));
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
    assert.ok(typeof body.reason_to_exist === 'string');
  });

  test('the template Spec placeholder restates the prose contract, not implementation prose', () => {
    const [story] = JSON.parse(renderStoriesTemplate());
    assert.match(story.body.spec, /contract and invariants only/i);
    assert.match(story.body.spec, /belong to the deliverer/i);
  });

  test('deterministic — two renders are byte-identical', () => {
    assert.equal(renderStoriesTemplate(), renderStoriesTemplate());
  });
});
