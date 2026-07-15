import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * `missing-reason-to-exist` soft-finding fixtures (Story #4273).
 *
 * `reason_to_exist` is marked REQUIRED by the decomposer prompt and is the
 * field the `epic-plan-consolidate` critic gates on — but that critic is an
 * honor-system LLM check with no runtime backstop. This deterministic finding
 * is the cheap backstop: `computeStorySizingFindings` emits a **soft**
 * `missing-reason-to-exist` finding when a Story body carries no non-empty
 * `reason_to_exist`, auto-surfaced through the existing findings pipeline. It
 * is advisory only — `validateAndNormalizeTickets` still returns successfully
 * and the finding rides the soft nudges array; it never contributes to
 * `errors[]`, so existing `reason_to_exist`-less standalone / audit Stories
 * are not blocked.
 */

const SIBLING_FILLER = Object.freeze({
  type: 'story',
  slug: 's-rte-filler',
  title: 'reason-to-exist fixtures — filler sibling',
  acceptance: ['filler observable criterion'],
  verify: ['npm test (unit)'],
  body: {
    goal: 'Benign filler sibling so the fixtures exercise a multi-Story backlog and the finding attaches only to the Story under test.',
    reason_to_exist:
      'Provide a benign sibling carrying a reason so the finding attaches only to the Story under test.',
    changes: ['src/_rte-filler.js: edit'],
    acceptance: ['filler observable criterion'],
    verify: ['npm test (unit)'],
  },
});

function makeStory(slug, reasonToExist) {
  const body = {
    goal: `Goal for ${slug}.`,
    changes: ['src/a.js: edit'],
    acceptance: ['the function returns a sorted list'],
    verify: ['npm test (unit)'],
  };
  if (reasonToExist !== undefined) body.reason_to_exist = reasonToExist;
  return {
    type: 'story',
    slug,
    title: `reason-to-exist story ${slug}`,
    acceptance: ['the function returns a sorted list'],
    verify: ['npm test (unit)'],
    body,
  };
}

function validateStory(slug, reasonToExist) {
  return validateAndNormalizeTickets([
    makeStory(slug, reasonToExist),
    SIBLING_FILLER,
  ]);
}

function reasonFindings(result) {
  return result.findings.filter((f) => f.kind === 'missing-reason-to-exist');
}

// ---------------------------------------------------------------------------
// Positive: a missing / empty reason_to_exist fires the soft finding
// ---------------------------------------------------------------------------

test('a Story body with no reason_to_exist produces a soft missing-reason-to-exist finding', () => {
  const result = validateStory('t-absent', undefined);
  const found = reasonFindings(result);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'soft');
  assert.equal(found[0].ticketSlug, 't-absent');
  // Advisory only — never reaches the hard errors[] channel.
  assert.deepEqual(result.errors, []);
});

test('a null reason_to_exist fires the finding', () => {
  const result = validateStory('t-null', null);
  assert.equal(reasonFindings(result).length, 1);
  assert.deepEqual(result.errors, []);
});

test('an empty / whitespace-only reason_to_exist fires the finding', () => {
  const blank = validateStory('t-empty', '');
  assert.equal(reasonFindings(blank).length, 1);

  const whitespace = validateStory('t-ws', '   ');
  assert.equal(reasonFindings(whitespace).length, 1);
});

test('the finding rides the advisory nudges array (severity soft, not in errors)', () => {
  const result = validateStory('t-advisory', undefined);
  const soft = result.findings.filter((f) => f.severity === 'soft');
  assert.ok(
    soft.some((f) => f.kind === 'missing-reason-to-exist'),
    'expected a missing-reason-to-exist finding in the soft nudges array',
  );
  assert.equal(result.errors.filter((e) => e.includes('reason')).length, 0);
});

// ---------------------------------------------------------------------------
// Negative: a present reason_to_exist suppresses the finding
// ---------------------------------------------------------------------------

test('a non-empty reason_to_exist suppresses the finding', () => {
  const result = validateStory(
    't-present',
    'This Story exists to add the deterministic reason_to_exist backstop.',
  );
  assert.deepEqual(reasonFindings(result), []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Message: names the field and instructs the author
// ---------------------------------------------------------------------------

test('the finding message names reason_to_exist and tells the author to state the reason', () => {
  const result = validateStory('t-message', undefined);
  const found = reasonFindings(result);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /reason_to_exist/);
  assert.match(found[0].message, /one Story = one coherent change/i);
});

// ---------------------------------------------------------------------------
// String body parity (Story #4271): the production serialized-string shape is
// scored identically to the pre-serialize object shape.
// ---------------------------------------------------------------------------

test('a serialized string body carrying reason_to_exist in its meta comment suppresses the finding', () => {
  const story = makeStory('t-string-present', undefined);
  story.body = [
    '## Goal',
    '',
    story.body.goal,
    '',
    '## Changes',
    '',
    '- {"path":"src/a.js","assumption":"refactors-existing"}',
    '',
    '## Acceptance',
    '',
    '- the function returns a sorted list',
    '',
    '## Verify',
    '',
    '- npm test (unit)',
    '',
    '<!-- meta: {"reason_to_exist": "This Story exists to exercise string-body parity."} -->',
  ].join('\n');
  const result = validateAndNormalizeTickets([story, SIBLING_FILLER]);
  assert.deepEqual(reasonFindings(result), []);
});

test('a serialized string body with no reason_to_exist meta fires the finding', () => {
  const story = makeStory('t-string-absent', undefined);
  story.body = [
    '## Goal',
    '',
    story.body.goal,
    '',
    '## Changes',
    '',
    '- {"path":"src/a.js","assumption":"refactors-existing"}',
    '',
    '## Acceptance',
    '',
    '- the function returns a sorted list',
    '',
    '## Verify',
    '',
    '- npm test (unit)',
  ].join('\n');
  const result = validateAndNormalizeTickets([story, SIBLING_FILLER]);
  assert.equal(reasonFindings(result).length, 1);
  assert.equal(reasonFindings(result)[0].ticketSlug, 't-string-absent');
});
