import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * `unanchored-constant` soft-finding fixtures (Story #3855).
 *
 * The heuristic flags a Story acceptance criterion that references a
 * configuration constant (retention window, rate limit, timeout, threshold,
 * quota, bounded window) without stating a concrete numeric value inline. It
 * is advisory only — `validateAndNormalizeTickets` still returns successfully
 * and the finding rides the advisory nudges array (`severity === 'soft'`)
 * alongside the sizing soft findings. It never contributes to `errors[]`.
 *
 * Observed gap (Story #3855): a criterion like
 * `"deletes rows older than the retention window"` forces an implementing
 * agent to context-hop to the Tech Spec (which itself only references an ADR)
 * to find the value — a preventable delivery friction point.
 */

const SIBLING_FILLER = Object.freeze({
  type: 'story',
  slug: 's-uc-filler',
  parent_slug: 'f-uc',
  title: 'Unanchored-constant fixtures — filler sibling',
  acceptance: ['filler observable criterion'],
  verify: ['npm test (unit)'],
  body: {
    goal: 'Filler sibling so the Feature has two Stories.',
    changes: ['src/_uc-filler.js: edit'],
    acceptance: ['filler observable criterion'],
    verify: ['npm test (unit)'],
  },
});

function makeStory(slug, acceptance) {
  return {
    type: 'story',
    slug,
    title: `Unanchored-constant story ${slug}`,
    acceptance,
    verify: ['npm test (unit)'],
    body: {
      goal: `Goal for ${slug}.`,
      changes: ['src/a.js: edit'],
      acceptance,
      verify: ['npm test (unit)'],
    },
  };
}

function validateStory(slug, acceptance, opts) {
  return validateAndNormalizeTickets(
    [makeStory(slug, acceptance), SIBLING_FILLER],
    opts,
  );
}

function unanchored(result) {
  return result.findings.filter((f) => f.kind === 'unanchored-constant');
}

// ---------------------------------------------------------------------------
// Positive: the canonical observed gap fires
// ---------------------------------------------------------------------------

test('"older than the retention window" (no numeric value) produces a soft unanchored-constant finding', () => {
  const result = validateStory('t-retention', [
    'deletes email_send_log rows older than the retention window',
  ]);
  const found = unanchored(result);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'soft');
  assert.equal(found[0].ticketSlug, 't-retention');
  assert.equal(
    found[0].criterion,
    'deletes email_send_log rows older than the retention window',
  );
  // Advisory only — the finding never reaches the hard errors[] channel.
  assert.deepEqual(result.errors, []);
});

test('the finding rides the advisory nudges array (severity soft, not in errors)', () => {
  const result = validateStory('t-advisory', [
    'requests are throttled by the rate limit',
  ]);
  const soft = result.findings.filter((f) => f.severity === 'soft');
  assert.ok(
    soft.some((f) => f.kind === 'unanchored-constant'),
    'expected an unanchored-constant finding in the soft nudges array',
  );
  assert.equal(result.errors.filter((e) => e.includes('unanchored')).length, 0);
});

// ---------------------------------------------------------------------------
// Negative: a concrete numeric value suppresses the finding
// ---------------------------------------------------------------------------

test('"older than 90 days" does NOT produce the finding', () => {
  const result = validateStory('t-90days', [
    'deletes email_send_log rows older than 90 days',
  ]);
  assert.deepEqual(unanchored(result), []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Message: identifies the criterion and instructs the author
// ---------------------------------------------------------------------------

test('the finding message names the criterion and tells the author to inline the value', () => {
  const result = validateStory('t-message', [
    'each session expires after the timeout',
  ]);
  const found = unanchored(result);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /each session expires after the timeout/);
  assert.match(found[0].message, /specify the value inline/i);
  // Example values appear so the author has a copyable shape.
  assert.match(found[0].message, /90 days|5 req\/s|30 minutes/);
});

// ---------------------------------------------------------------------------
// Pattern coverage: every required phrase trips (Story #3855 AC)
// ---------------------------------------------------------------------------

const PATTERN_CASES = [
  ['retention window', 'purges rows beyond the retention window'],
  ['rate limit', 'inbound calls obey the rate limit'],
  ['rate-limit', 'the rate-limit policy applies per tenant'],
  ['timeout', 'the request aborts on timeout'],
  ['older than', 'rows older than the cutoff are removed'],
  ['within N', 'retries happen within the configured window'],
  ['max.*per', 'enforces the max requests per tenant'],
  ['quota', 'uploads stop once the quota is reached'],
];

for (const [label, criterion] of PATTERN_CASES) {
  test(`pattern "${label}" trips unanchored-constant`, () => {
    const slug = `t-pat-${label.replace(/[^a-z]+/gi, '-')}`;
    const result = validateStory(slug, [criterion]);
    const found = unanchored(result);
    assert.equal(
      found.length,
      1,
      `expected pattern "${label}" to trip on: ${criterion}`,
    );
  });
}

// ---------------------------------------------------------------------------
// No false positives on benign prose
// ---------------------------------------------------------------------------

test('benign acceptance criteria with no config-constant phrase produce no finding', () => {
  const result = validateStory('t-benign', [
    'the function returns a sorted list',
    'an invalid input throws a ValidationError',
    'the parser handles an empty body',
  ]);
  assert.deepEqual(unanchored(result), []);
});

test('a digit anywhere in the criterion suppresses the finding (5 req/s, 30 minutes)', () => {
  const result = validateStory('t-digits', [
    'inbound calls obey the rate limit of 5 req/s',
    'each session expires after a 30 minute timeout',
    'enforces a max of 100 requests per tenant',
  ]);
  assert.deepEqual(unanchored(result), []);
});

// ---------------------------------------------------------------------------
// Multiple offending criteria each surface independently
// ---------------------------------------------------------------------------

test('each offending criterion produces its own finding', () => {
  const result = validateStory('t-multi', [
    'purges rows beyond the retention window',
    'inbound calls obey the rate limit',
    'the request aborts on timeout',
  ]);
  assert.equal(unanchored(result).length, 3);
});
