import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import {
  DEFAULT_MODEL_CAPACITY,
  estimateStorySessionMass,
  resolveCapacityCeilings,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';
import { serialize as serializeStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';

/**
 * Sizing validator fixtures for the v2 model-capacity split advisory.
 *
 * File/AC ceilings and AC/file delivery-cost proxies are gone. The model
 * scores **authored tokens only** against absolute session-mass ceilings.
 * Declaring `wide` with a reason lifts the hard session-mass rejection.
 */

const CEILINGS = resolveCapacityCeilings(DEFAULT_MODEL_CAPACITY);

/** Pad a Spec so authored session mass lands above `targetTokens`. */
function specAbove(targetTokens) {
  // estimateTokens = ceil(length / 4); leave headroom for other body fields.
  return 'x'.repeat((targetTokens + 200) * 4);
}

function makeStory(slug = 's-sizing', body) {
  const structured = {
    goal: `Goal for ${slug}.`,
    reason_to_exist: `Single coherent reason ${slug} exists.`,
    changes: ['src/a.js: edit'],
    acceptance: ['observable criterion'],
    verify: ['npm test (unit)'],
    ...body,
  };
  return {
    type: 'story',
    slug,
    title: `Sizing story ${slug}`,
    acceptance: structured.acceptance,
    verify: structured.verify,
    body: structured,
  };
}

function changes(n, verb = 'edit') {
  return Array.from({ length: n }, (_, i) => `src/file${i}.js: ${verb}`);
}

const SIBLING_FILLER = Object.freeze({
  type: 'story',
  slug: 's-sizing-filler',
  title: 'Sizing fixtures — filler sibling',
  acceptance: ['filler observable criterion'],
  verify: ['npm test (unit)'],
  body: {
    goal: 'Filler sibling so the Feature has two Stories.',
    reason_to_exist: 'Benign filler sibling so the Feature has two Stories.',
    changes: ['src/_sizing-filler.js: edit'],
    acceptance: ['filler observable criterion'],
    verify: ['npm test (unit)'],
  },
});

function validateStory(story, opts) {
  return validateAndNormalizeTickets([story, SIBLING_FILLER], opts);
}

function storyWithFileCount(slug, fileCount, extras = {}) {
  return makeStory(slug, {
    changes: changes(fileCount),
    acceptance: ['criterion 1'],
    ...extras,
  });
}

function storyAboveSoft(slug, extras = {}) {
  return makeStory(slug, {
    spec: specAbove(CEILINGS.softSessionTokens),
    ...extras,
  });
}

function storyAboveHard(slug, extras = {}) {
  return makeStory(slug, {
    spec: specAbove(CEILINGS.hardSessionTokens),
    ...extras,
  });
}

// ---------------------------------------------------------------------------
// Capacity ceilings — absolute authored-token counts
// ---------------------------------------------------------------------------

test('resolveCapacityCeilings returns DEFAULT_MODEL_CAPACITY absolute token ceilings', () => {
  assert.equal(CEILINGS.softSessionTokens, 30000);
  assert.equal(CEILINGS.hardSessionTokens, 75000);
  assert.equal(CEILINGS.mergeCandidateMaxSessionTokens, 1500);
});

test('DEFAULT_MODEL_CAPACITY has no AC/file delivery-cost proxies', () => {
  assert.equal(DEFAULT_MODEL_CAPACITY.tokensPerAcceptance, undefined);
  assert.equal(DEFAULT_MODEL_CAPACITY.tokensPerChange, undefined);
  assert.equal(DEFAULT_MODEL_CAPACITY.softFiles, undefined);
  assert.equal(DEFAULT_MODEL_CAPACITY.hardFiles, undefined);
});

test('estimateStorySessionMass is authored tokens only', () => {
  const story = makeStory('t-mass', {
    changes: changes(4),
    acceptance: ['a', 'b'],
    spec: 'short approach',
  });
  const mass = estimateStorySessionMass(story);
  assert.equal(mass.fileCount, 4);
  assert.equal(mass.acceptanceCount, 2);
  assert.ok(mass.authoredTokens > 0);
  assert.equal(mass.sessionMass, mass.authoredTokens);
});

// ---------------------------------------------------------------------------
// Narrow Story baseline — no findings
// ---------------------------------------------------------------------------

test('narrow Story with no wide declaration produces no capacity findings', () => {
  const result = validateStory(
    makeStory('t-narrow', {
      changes: ['src/a.js: edit', 'src/b.js: edit', 'src/c.js: edit'],
      acceptance: ['criterion 1', 'criterion 2'],
    }),
  );
  const capacity = result.findings.filter((f) =>
    ['oversized-task', 'soft-session-pressure', 'wide-undeclared'].includes(
      f.kind,
    ),
  );
  assert.deepEqual(capacity, []);
  assert.deepEqual(result.errors, []);
});

test('file count alone never hard-rejects — 90 files stay under hard ceiling', () => {
  const result = validateStory(storyWithFileCount('t-90files-ok', 90));
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
});

test('many acceptance criteria alone never soft-nudge or hard-reject', () => {
  // Authored AC text for 50 short criteria is far below the 30k soft ceiling.
  const result = validateStory(
    makeStory('t-50ac', {
      changes: ['src/a.js: edit'],
      acceptance: Array.from({ length: 50 }, (_, i) => `criterion ${i}`),
    }),
  );
  assert.deepEqual(
    result.findings.filter((f) =>
      ['oversized-task', 'wide-undeclared', 'soft-session-pressure'].includes(
        f.kind,
      ),
    ),
    [],
  );
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Soft / hard session-mass ceilings (authored Spec padding)
// ---------------------------------------------------------------------------

test('session mass above soft ceiling with no wide emits wide-undeclared', () => {
  const result = validateStory(storyAboveSoft('t-soft'));
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.ok(nudge[0].sessionMass > CEILINGS.softSessionTokens);
  assert.equal(nudge[0].softSessionTokens, CEILINGS.softSessionTokens);
});

test('session mass above hard ceiling with no wide trips oversized-task', () => {
  const result = validateStory(storyAboveHard('t-hard'));
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'sessionMass',
  );
  assert.equal(hard.length, 1);
  assert.ok(hard[0].observed > CEILINGS.hardSessionTokens);
  assert.equal(hard[0].ceiling, CEILINGS.hardSessionTokens);
  assert.equal(
    result.errors.filter((e) => e.includes('session-capacity ceiling')).length,
    1,
  );
});

test('wide declaration lifts the hard session-mass ceiling (soft pressure only)', () => {
  const result = validateStory(
    storyAboveHard('t-hard-wide', {
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-session-pressure',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].field, 'sessionMass');
});

test('soft-over with wide emits soft-session-pressure, not wide-undeclared', () => {
  const result = validateStory(
    storyAboveSoft('t-soft-wide', {
      wide: { reason: 'legitimately broad: scaffold a new package skeleton' },
    }),
  );
  assert.deepEqual(
    result.findings.filter((f) => f.kind === 'wide-undeclared'),
    [],
  );
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-session-pressure',
  );
  assert.equal(soft.length, 1);
  assert.deepEqual(result.errors, []);
});

test('a wide declaration with an empty reason does NOT lift the hard ceiling', () => {
  const result = validateStory(
    storyAboveHard('t-wide-empty-reason', {
      wide: { reason: '   ' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'sessionMass',
  );
  assert.equal(hard.length, 1);
});

// ---------------------------------------------------------------------------
// Glob-aware sizing — unknown-width still nudges for wide
// ---------------------------------------------------------------------------

test('glob entry with no wide declaration emits wide-undeclared (soft)', () => {
  const result = validateStory(
    makeStory('t-glob-no-wide', {
      changes: ['**/*.ts: update imports'],
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].reason, 'glob-changes');
});

test('glob entry WITH a wide declaration produces no wide-undeclared finding', () => {
  const result = validateStory(
    makeStory('t-glob-wide', {
      changes: ['**/*.ts: update imports'],
      wide: { reason: 'mechanical sweep: rename across every consumer site' },
    }),
  );
  assert.deepEqual(
    result.findings.filter((f) => f.kind === 'wide-undeclared'),
    [],
  );
  assert.deepEqual(result.errors, []);
});

test('many glob paths alone do not trip hard (authored mass stays small)', () => {
  const result = validateStory(
    makeStory('t-glob-many', {
      changes: Array.from({ length: 100 }, (_, i) => `src/**/${i}.ts: edit`),
      wide: { reason: 'sweep' },
    }),
  );
  const hard = result.findings.filter((f) => f.kind === 'oversized-task');
  assert.deepEqual(hard, []);
});

// ---------------------------------------------------------------------------
// 2-tier guard
// ---------------------------------------------------------------------------

test('rejects a Story that lacks an inline acceptance + verify contract', () => {
  assert.throws(
    () =>
      validateAndNormalizeTickets([
        {
          type: 'story',
          slug: 's-no-contract',
          title: 'Story without inline contract',
          body: { goal: 'Goal.', changes: ['src/a.js: edit'] },
        },
        SIBLING_FILLER,
      ]),
    /lack an inline acceptance \+ verify contract/,
  );
});

// ---------------------------------------------------------------------------
// Canonical serialized STRING body
// ---------------------------------------------------------------------------

function makeStringStory(slug, body = {}) {
  const structured = {
    goal: `Goal for ${slug}.`,
    reason_to_exist: `Single coherent reason ${slug} exists.`,
    changes: ['src/a.js: edit'],
    acceptance: ['observable criterion'],
    verify: ['npm test (unit)'],
    ...body,
  };
  return {
    type: 'story',
    slug,
    title: `Sizing story ${slug}`,
    acceptance: structured.acceptance,
    verify: structured.verify,
    body: serializeStoryBody(structured),
  };
}

test('string body: over-hard session mass trips oversized-task', () => {
  const result = validateStory(
    makeStringStory('t-str-hard', {
      spec: specAbove(CEILINGS.hardSessionTokens),
      acceptance: ['criterion 1'],
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'sessionMass',
  );
  assert.equal(hard.length, 1);
});

test('string body: unanchored-constant fires identically to the object case', () => {
  const result = validateStory(
    makeStringStory('t-str-unanch', {
      acceptance: ['Records older than the retention window are purged'],
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'unanchored-constant');
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].ticketSlug, 't-str-unanch');
});

test('string body: a declared wide reason lifts the hard session ceiling', () => {
  const result = validateStory(
    makeStringStory('t-str-hard-wide', {
      spec: specAbove(CEILINGS.hardSessionTokens),
      acceptance: ['criterion 1'],
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  );
  assert.deepEqual(
    result.findings.filter((f) => f.severity === 'hard'),
    [],
  );
  assert.equal(
    result.findings.filter((f) => f.kind === 'soft-session-pressure').length,
    1,
  );
});

test('session mass reads the authoritative top-level story.acceptance', () => {
  // Top-level acceptance carries a long padded criterion; body carries a
  // short one. Mass MUST use the top-level binding contract.
  const result = validateStory({
    type: 'story',
    slug: 't-toplevel-ac',
    title: 'Top-level acceptance authority',
    acceptance: [specAbove(CEILINGS.softSessionTokens)],
    verify: ['npm test (unit)'],
    body: {
      goal: 'Goal.',
      reason_to_exist: 'Top-level acceptance drives session mass.',
      changes: ['src/a.js: edit'],
      acceptance: ['only two', 'criteria'],
      verify: ['npm test (unit)'],
    },
  });
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
});

// ---------------------------------------------------------------------------
// merge-candidate under-size soft finding
// ---------------------------------------------------------------------------

test('fires on a tiny chained Story (soft, never in errors[])', () => {
  const story = makeStory('t-merge-fires', {
    changes: ['src/a.js: edit'],
    acceptance: ['criterion 1'],
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);

  const merge = result.findings.filter((f) => f.kind === 'merge-candidate');
  assert.equal(merge.length, 1);
  assert.equal(merge[0].severity, 'soft');
  assert.ok(merge[0].sessionMass <= CEILINGS.mergeCandidateMaxSessionTokens);
  assert.deepEqual(merge[0].dependsOn, ['s-sizing-filler']);
  assert.deepEqual(
    result.findings.filter((f) => f.severity === 'hard'),
    [],
  );
  assert.deepEqual(result.errors, []);
});

test('the rendered advisory names the depended-on sibling and recommends merging', () => {
  const story = makeStory('t-merge-message', {
    changes: ['src/a.js: edit'],
    acceptance: ['criterion 1'],
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);

  const merge = result.findings.find((f) => f.kind === 'merge-candidate');
  assert.ok(merge);
  assert.match(merge.message, /s-sizing-filler/);
  assert.match(merge.message, /merg/i);
});

test('silent on a tiny ORPHAN Story (no depends_on edge)', () => {
  const result = validateStory(
    makeStory('t-merge-orphan', {
      changes: ['src/a.js: edit'],
      acceptance: ['criterion 1'],
    }),
  );
  assert.deepEqual(
    result.findings.filter((f) => f.kind === 'merge-candidate'),
    [],
  );
});

test('silent on a normal-sized chained Story (mass above merge ceiling)', () => {
  const story = makeStory('t-merge-normal', {
    spec: specAbove(CEILINGS.mergeCandidateMaxSessionTokens),
    changes: changes(8),
    acceptance: ['criterion 1', 'criterion 2'],
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);
  assert.deepEqual(
    result.findings.filter((f) => f.kind === 'merge-candidate'),
    [],
  );
});

test('respects a programmatic capacity threshold override', () => {
  // Mid-mass chained Story: above the default merge ceiling (1.5k) so
  // silent by default; raising mergeCandidateMaxSessionTokens to 6k flags it.
  const makeChained = (slug) => {
    const s = makeStory(slug, {
      spec: specAbove(2000),
      changes: changes(4),
      acceptance: ['criterion 1'],
    });
    s.depends_on = ['s-sizing-filler'];
    return s;
  };

  const defaultResult = validateStory(makeChained('t-merge-default'));
  assert.deepEqual(
    defaultResult.findings.filter((f) => f.kind === 'merge-candidate'),
    [],
    'default merge ceiling leaves a mid-mass Story silent',
  );

  const overrideResult = validateStory(makeChained('t-merge-override'), {
    modelCapacity: { mergeCandidateMaxSessionTokens: 6000 },
  });
  assert.equal(
    overrideResult.findings.filter((f) => f.kind === 'merge-candidate').length,
    1,
    'raising the merge ceiling flags the same Story',
  );
});

test('silent on a chained Story that carries a glob change (unknown width)', () => {
  const story = makeStory('t-merge-glob', {
    changes: ['**/*.ts: update imports'],
    acceptance: ['criterion 1'],
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);
  assert.deepEqual(
    result.findings.filter((f) => f.kind === 'merge-candidate'),
    [],
  );
});

test('modelCapacity override retunes the absolute ceilings', () => {
  const result = validateStory(
    makeStory('t-capacity', {
      spec: specAbove(500),
    }),
    { modelCapacity: { hardSessionTokens: 500 } },
  );
  const hard = result.findings.filter((f) => f.kind === 'oversized-task');
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 500);
  assert.equal(hard[0].ticketSlug, 't-capacity');
});
