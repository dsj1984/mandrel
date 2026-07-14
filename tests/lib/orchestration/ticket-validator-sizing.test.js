import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS_DEFAULTS } from '../../../.agents/scripts/lib/config/limits.js';
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
 * File/AC ceilings are gone. The model scores estimated **session mass**
 * (authored tokens + per-AC / per-file delivery proxies) against fractions of
 * `maxTokenBudget`. Declaring `wide` with a reason lifts the hard session-mass
 * rejection.
 */

const CEILINGS = resolveCapacityCeilings(
  DEFAULT_MODEL_CAPACITY,
  LIMITS_DEFAULTS.maxTokenBudget,
);

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

/** Build a Story whose session mass lands in a target band via file count. */
function storyWithFileCount(slug, fileCount, extras = {}) {
  return makeStory(slug, {
    changes: changes(fileCount),
    acceptance: ['criterion 1'],
    ...extras,
  });
}

// ---------------------------------------------------------------------------
// Capacity ceilings — derived from maxTokenBudget
// ---------------------------------------------------------------------------

test('resolveCapacityCeilings derives absolute tokens from maxTokenBudget fractions', () => {
  assert.equal(CEILINGS.maxTokenBudget, 300000);
  assert.equal(CEILINGS.softSessionTokens, 12000);
  assert.equal(CEILINGS.hardSessionTokens, 30000);
  assert.equal(CEILINGS.mergeCandidateMaxSessionTokens, 1500);
});

test('estimateStorySessionMass folds authored tokens + AC/change proxies', () => {
  const story = makeStory('t-mass', {
    changes: changes(4),
    acceptance: ['a', 'b'],
  });
  const mass = estimateStorySessionMass(story);
  assert.equal(mass.fileCount, 4);
  assert.equal(mass.acceptanceCount, 2);
  assert.ok(mass.authoredTokens > 0);
  assert.equal(
    mass.sessionMass,
    mass.authoredTokens +
      2 * DEFAULT_MODEL_CAPACITY.tokensPerAcceptance +
      4 * DEFAULT_MODEL_CAPACITY.tokensPerChange,
  );
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

test('file count alone no longer hard-rejects — 31 files stay under hard ceiling', () => {
  // Under the retired DEFAULT_TASK_SIZING this was a hard reject. Under
  // model capacity, 31 files × 350 ≈ 10.8k + AC proxy is still well under
  // the 30k hard session ceiling.
  const result = validateStory(storyWithFileCount('t-31files-ok', 31));
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Soft / hard session-mass ceilings
// ---------------------------------------------------------------------------

test('session mass above soft ceiling with no wide emits wide-undeclared', () => {
  // ~40 files × 350 = 14_000 > soft 12_000.
  const result = validateStory(storyWithFileCount('t-soft', 40));
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.ok(nudge[0].sessionMass > CEILINGS.softSessionTokens);
  assert.equal(nudge[0].softSessionTokens, CEILINGS.softSessionTokens);
});

test('session mass above hard ceiling with no wide trips oversized-task', () => {
  // ~90 files × 350 = 31_500 > hard 30_000.
  const result = validateStory(storyWithFileCount('t-hard', 90));
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
    storyWithFileCount('t-hard-wide', 90, {
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
    storyWithFileCount('t-soft-wide', 40, {
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
    storyWithFileCount('t-wide-empty-reason', 90, {
      wide: { reason: '   ' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'sessionMass',
  );
  assert.equal(hard.length, 1);
});

test('acceptance mass contributes to session mass (many ACs can soft-nudge)', () => {
  // 30 ACs × 500 = 15_000 > soft 12_000, with a single file.
  const result = validateStory(
    makeStory('t-many-ac', {
      changes: ['src/a.js: edit'],
      acceptance: Array.from({ length: 30 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
});

test('acceptance mass alone never hard-rejects below the session ceiling', () => {
  // 50 ACs × 500 = 25_000 < hard 30_000 — soft nudge only.
  const result = validateStory(
    makeStory('t-50ac', {
      changes: ['src/a.js: edit'],
      acceptance: Array.from({ length: 50 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter((f) => f.kind === 'oversized-task');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Glob-aware sizing — unknown-width skips the per-file proxy
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

test('glob entries skip the per-file proxy — many globs alone do not trip hard', () => {
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
// PathEntry object form
// ---------------------------------------------------------------------------

test('changes[] with PathEntry object form counts toward session mass', () => {
  const result = validateStory(
    makeStory('t-pathentry', {
      changes: Array.from({ length: 40 }, (_, i) => ({
        path: `src/file${i}.js`,
        assumption: i === 0 ? 'creates' : 'refactors-existing',
      })),
      acceptance: ['criterion 1'],
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.ok(nudge[0].sessionMass > CEILINGS.softSessionTokens);
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
      changes: Array.from({ length: 90 }, (_, i) => ({
        path: `src/file${i}.js`,
        assumption: 'refactors-existing',
      })),
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
      changes: Array.from({ length: 90 }, (_, i) => ({
        path: `src/file${i}.js`,
        assumption: 'refactors-existing',
      })),
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
  // Top-level acceptance carries 30 items; body carries only 2. Mass MUST
  // use the top-level binding contract.
  const result = validateStory({
    type: 'story',
    slug: 't-toplevel-ac',
    title: 'Top-level acceptance authority',
    acceptance: Array.from({ length: 30 }, (_, i) => `top criterion ${i}`),
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

test('respects a planning.modelCapacity threshold override', () => {
  const makeChained = (slug) => {
    const s = makeStory(slug, {
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
    'default merge ceiling leaves a 4-file Story silent',
  );

  const overrideResult = validateStory(makeChained('t-merge-override'), {
    modelCapacity: { mergeCandidateMaxSessionFraction: 0.02 },
  });
  assert.equal(
    overrideResult.findings.filter((f) => f.kind === 'merge-candidate').length,
    1,
    'raising the merge fraction flags the same Story',
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

test('maxTokenBudget override retunes the absolute ceilings', () => {
  // Budget where hard = 0.1 * 20000 = 2000. A 10-file Story exceeds it;
  // the filler sibling (~1 file) stays under, so only one hard finding fires.
  const result = validateStory(storyWithFileCount('t-budget', 10), {
    maxTokenBudget: 20000,
  });
  const hard = result.findings.filter((f) => f.kind === 'oversized-task');
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 2000);
  assert.equal(hard[0].ticketSlug, 't-budget');
});
