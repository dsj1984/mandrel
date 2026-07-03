import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';
import { serialize as serializeStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';

/**
 * Sizing validator fixtures for the collapsed sizing model (Story #3760),
 * re-pointed at the uniform relaxed profile (Story #3874).
 *
 * The per-profile ceiling matrix, the parallel `testSurface` axis, and the
 * `sizingProfile` enum (`atomic-rewrite` / `scaffolding` / `mechanical-sweep`)
 * are gone. The model is now:
 *
 *   - Flat knobs (DEFAULT_TASK_SIZING): softFiles=15, hardFiles=30,
 *     maxAcceptance=14, softAcceptanceCount=10.
 *   - A single optional `body.wide = { reason }` declaration. Declaring `wide`
 *     with a non-empty reason lifts the hardFiles rejection — no Story is
 *     rejected for width when `wide` is declared.
 *   - Cohesion is the primary heuristic; the numeric ceiling is a backstop.
 *
 * Findings:
 *   - oversized-task (hard) — acceptance > maxAcceptance, or fileCount >
 *     hardFiles when `wide` is not declared.
 *   - soft-task-width (soft) — acceptance > softAcceptanceCount, or fileCount >
 *     softFiles (when `wide` IS declared — declared-wide Stories still surface
 *     the width as advisory signal).
 *   - wide-undeclared (soft) — fileCount > softFiles with no `wide`
 *     declaration, or glob changes with no `wide` declaration.
 *
 * 2-tier (Epic #3238): each Story is its own implementation unit and carries
 * the `body` (goal / changes / acceptance / verify / wide) plus the top-level
 * `acceptance[]` + `verify[]` inline contract the validator requires.
 */

function makeStory(slug = 's-sizing', body) {
  const structured = {
    goal: `Goal for ${slug}.`,
    // Carry a non-empty reason_to_exist by default so the deterministic
    // `missing-reason-to-exist` soft finding (Story #4273) does not perturb
    // the width / wide assertions under test. A test exercising the absent
    // case overrides it via `body`.
    reason_to_exist: `Single coherent reason ${slug} exists.`,
    changes: ['src/a.js: edit'],
    acceptance: ['observable criterion'],
    verify: ['npm test (unit)'],
    ...body,
  };
  // The decomposer mirrors the structured body's acceptance / verify onto the
  // authoritative top-level inline contract. Mirror that here so the
  // acceptance ceiling — which reads the top-level `story.acceptance`
  // (Story #4271) — sees whatever the fixture's body declares.
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

/**
 * Benign filler sibling Story. It touches a single unique path, has a
 * minimal inline contract, and declares no glob / wide — so it adds ZERO
 * sizing or conflict findings and never perturbs the assertions under
 * test.
 */
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

/**
 * Validate a single Story alongside the benign filler sibling.
 * Tests that need a custom invalid
 * story (e.g. the missing-inline-contract case) call
 * `validateAndNormalizeTickets` directly with their own array.
 */
function validateStory(story, opts) {
  return validateAndNormalizeTickets([story, SIBLING_FILLER], opts);
}

// ---------------------------------------------------------------------------
// Narrow Story baseline — no findings
// ---------------------------------------------------------------------------

test('narrow Story with no wide declaration produces no findings', () => {
  const result = validateStory(
    makeStory('t-narrow', {
      changes: ['src/a.js: edit', 'src/b.js: edit', 'src/c.js: edit'],
      acceptance: ['criterion 1', 'criterion 2'],
    }),
  );
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// Acceptance ceiling — maxAcceptance=14, softAcceptanceCount=10
// ---------------------------------------------------------------------------

test('Story with 14 acceptance items validates clean (maxAcceptance=14)', () => {
  const result = validateStory(
    makeStory('t-14ac', {
      acceptance: Array.from({ length: 14 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
});

test('Story with 15 acceptance items trips hard oversized-task (ceiling=14)', () => {
  const result = validateStory(
    makeStory('t-15ac', {
      acceptance: Array.from({ length: 15 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 15);
  assert.equal(hard[0].ceiling, 14);
  assert.equal(
    result.errors.filter((e) => e.includes('acceptance ceiling')).length,
    1,
  );
});

test('Story with 11 acceptance items emits soft-task-width on acceptance field', () => {
  const result = validateStory(
    makeStory('t-11ac-soft', {
      acceptance: Array.from({ length: 11 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'acceptance',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 11);
  assert.equal(soft[0].soft, 10);
});

test('wide lifts only the file ceiling — 15 acceptance items still hard-reject with wide declared', () => {
  const result = validateStory(
    makeStory('t-15ac-wide', {
      acceptance: Array.from({ length: 15 }, (_, i) => `criterion ${i}`),
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 15);
  assert.equal(hard[0].ceiling, 14);
  assert.equal(
    result.errors.filter((e) => e.includes('acceptance ceiling')).length,
    1,
  );
});

// ---------------------------------------------------------------------------
// File width — single ceiling (softFiles=15, hardFiles=30)
// ---------------------------------------------------------------------------

test('15 files (at softFiles) produces no width finding', () => {
  const result = validateStory(
    makeStory('t-15files', { changes: changes(15) }),
  );
  const widthFindings = result.findings.filter(
    (f) => f.kind === 'wide-undeclared' || f.field === 'fileCount',
  );
  assert.deepEqual(widthFindings, []);
  assert.deepEqual(result.errors, []);
});

test('16 files (>softFiles) with no wide declaration emits wide-undeclared (soft, no rejection)', () => {
  const result = validateStory(
    makeStory('t-16files', { changes: changes(16) }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].fileCount, 16);
  assert.equal(nudge[0].softFiles, 15);
});

test('31 files (>hardFiles) with no wide declaration trips hard oversized-task on fileCount', () => {
  const result = validateStory(
    makeStory('t-31files', { changes: changes(31) }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 31);
  assert.equal(hard[0].ceiling, 30);
  assert.equal(
    result.errors.filter((e) => e.includes('fileCount ceiling')).length,
    1,
  );
});

test('31 files WITH a wide declaration lifts the hard ceiling (soft-task-width only)', () => {
  const result = validateStory(
    makeStory('t-31files-wide', {
      changes: changes(31),
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  assert.deepEqual(result.errors, []);
  // Declared-wide Stories still surface the width as advisory signal.
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'fileCount',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 31);
  assert.equal(soft[0].soft, 15);
});

test('16 files WITH a wide declaration emits soft-task-width, not wide-undeclared', () => {
  const result = validateStory(
    makeStory('t-16files-wide', {
      changes: changes(16),
      wide: { reason: 'legitimately broad: scaffold a new package skeleton' },
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.deepEqual(nudge, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'fileCount',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 16);
  assert.equal(soft[0].soft, 15);
  assert.deepEqual(result.errors, []);
});

test('a wide declaration with an empty reason does NOT lift the hard ceiling', () => {
  const result = validateStory(
    makeStory('t-wide-empty-reason', {
      changes: changes(31),
      wide: { reason: '   ' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].ceiling, 30);
});

// ---------------------------------------------------------------------------
// Glob-aware sizing — unknown-width bypasses the numeric ceiling
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
  assert.equal(nudge[0].ticketSlug, 't-glob-no-wide');
  assert.equal(nudge[0].reason, 'glob-changes');
});

test('glob entry WITH a wide declaration produces no wide-undeclared finding', () => {
  const result = validateStory(
    makeStory('t-glob-wide', {
      changes: ['**/*.ts: update imports'],
      wide: { reason: 'mechanical sweep: rename across every consumer site' },
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.deepEqual(nudge, []);
  assert.deepEqual(result.errors, []);
});

test('glob entries skip the numeric ceiling — 100 globs never trip oversized-task', () => {
  const result = validateStory(
    makeStory('t-glob-many', {
      changes: Array.from({ length: 100 }, (_, i) => `src/**/${i}.ts: edit`),
      wide: { reason: 'sweep' },
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.deepEqual(hard, []);
});

// ---------------------------------------------------------------------------
// PathEntry object form in changes[] counts files correctly
// ---------------------------------------------------------------------------

test('changes[] with PathEntry object form counts files correctly (not zero)', () => {
  // 16 PathEntry objects, no wide → wide-undeclared (fileCount=16 > softFiles=15).
  const result = validateStory(
    makeStory('t-pathentry', {
      changes: [
        { path: 'src/a.js', assumption: 'creates' },
        { path: 'src/b.js', assumption: 'refactors-existing' },
        { path: 'src/c.js', assumption: 'exists' },
        { path: 'src/d.js', assumption: 'deletes' },
        { path: 'src/e.js', assumption: 'refactors-existing' },
        { path: 'src/f.js', assumption: 'refactors-existing' },
        { path: 'src/g.js', assumption: 'refactors-existing' },
        { path: 'src/h.js', assumption: 'refactors-existing' },
        { path: 'src/i.js', assumption: 'refactors-existing' },
        { path: 'src/j.js', assumption: 'refactors-existing' },
        { path: 'src/k.js', assumption: 'refactors-existing' },
        { path: 'src/l.js', assumption: 'refactors-existing' },
        { path: 'src/m.js', assumption: 'refactors-existing' },
        { path: 'src/n.js', assumption: 'refactors-existing' },
        { path: 'src/o.js', assumption: 'refactors-existing' },
        { path: 'src/p.js', assumption: 'refactors-existing' },
      ],
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(
    nudge.length,
    1,
    'expected wide-undeclared for 16 PathEntry changes',
  );
  assert.equal(nudge[0].fileCount, 16);
});

test('changes[] with a glob PathEntry object triggers wide-undeclared', () => {
  const result = validateStory(
    makeStory('t-glob-pathentry', {
      changes: [{ path: '**/*.js', assumption: 'refactors-existing' }],
    }),
  );
  const nudge = result.findings.filter((f) => f.kind === 'wide-undeclared');
  assert.equal(nudge.length, 1);
});

// ---------------------------------------------------------------------------
// 2-tier guard — a Story missing its inline acceptance + verify contract is
// rejected (Epic #3238).
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
// Canonical serialized STRING body — production shape (Story #4271)
//
// The decomposer mandates `body` as a serialized markdown string, but the
// sizing layers historically read `story.body` only when it was already an
// object — so on the production string shape `hardFiles`, `maxAcceptance`,
// and the `unanchored-constant` nudge all emitted nothing. These fixtures
// exercise the canonical string shape at parity with the object-body cases
// above. The freshness gate already string-aware via parseStoryBody;
// `computeStorySizingFindings` now mirrors that.
// ---------------------------------------------------------------------------

/**
 * Build a Story whose `body` is the canonical serialized **string** the
 * decomposer emits (via `serialize()`), with the authoritative top-level
 * `acceptance[]` / `verify[]` inline contract the validator requires. The
 * structured body fields (`changes` / `wide` / body-level `acceptance`)
 * survive the serialize → parse round-trip the gate runs internally.
 */
function makeStringStory(slug, body = {}) {
  const structured = {
    goal: `Goal for ${slug}.`,
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

function objectChanges(n, verb = 'refactors-existing') {
  return Array.from({ length: n }, (_, i) => ({
    path: `src/file${i}.js`,
    assumption: i === 0 ? 'creates' : verb,
  }));
}

test('string body: >hardFiles distinct changes paths trips hard oversized-task on fileCount', () => {
  const result = validateStory(
    makeStringStory('t-str-31files', { changes: objectChanges(31) }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'fileCount',
  );
  assert.equal(
    hard.length,
    1,
    'expected the file-width hard finding on a string body',
  );
  assert.equal(hard[0].observed, 31);
  assert.equal(hard[0].ceiling, 30);
  assert.equal(
    result.errors.filter((e) => e.includes('fileCount ceiling')).length,
    1,
  );
});

test('string body: >maxAcceptance acceptance items trips hard oversized-task on acceptance', () => {
  const result = validateStory(
    makeStringStory('t-str-15ac', {
      acceptance: Array.from({ length: 15 }, (_, i) => `criterion ${i}`),
    }),
  );
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.equal(
    hard.length,
    1,
    'expected the acceptance hard finding on a string body',
  );
  assert.equal(hard[0].observed, 15);
  assert.equal(hard[0].ceiling, 14);
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

test('string body: a declared wide reason lifts the hard file ceiling', () => {
  const result = validateStory(
    makeStringStory('t-str-31files-wide', {
      changes: objectChanges(31),
      wide: { reason: 'hard contract cutover across every call site' },
    }),
  );
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
  const soft = result.findings.filter(
    (f) => f.kind === 'soft-task-width' && f.field === 'fileCount',
  );
  assert.equal(soft.length, 1);
  assert.equal(soft[0].observed, 31);
});

test('acceptance ceiling reads the authoritative top-level story.acceptance, not body.acceptance', () => {
  // Top-level acceptance carries 15 items (> ceiling 14); the structured
  // body's acceptance carries only 2. The ceiling MUST read the top-level
  // binding contract regardless of what the body says.
  const result = validateStory({
    type: 'story',
    slug: 't-toplevel-ac',
    title: 'Top-level acceptance authority',
    acceptance: Array.from({ length: 15 }, (_, i) => `top criterion ${i}`),
    verify: ['npm test (unit)'],
    body: {
      goal: 'Goal.',
      changes: ['src/a.js: edit'],
      acceptance: ['only two', 'criteria'],
      verify: ['npm test (unit)'],
    },
  });
  const hard = result.findings.filter(
    (f) => f.kind === 'oversized-task' && f.field === 'acceptance',
  );
  assert.equal(hard.length, 1);
  assert.equal(hard[0].observed, 15);
});

// ---------------------------------------------------------------------------
// merge-candidate under-size soft finding (Story #4312)
//
// The symmetric backstop to the over-size ceilings. A Story that looks like a
// dependent fragment rather than a capability slice — ≤ mergeCandidateMaxFiles
// declared changes[] files AND ≤ mergeCandidateMaxAcceptance acceptance items
// AND at least one depends_on edge to a sibling — trips an advisory `soft`
// finding recommending a merge into the consumer. A tiny ORPHAN Story (no
// depends_on) stays silent. Never a rejection: never in errors[], never hard.
//
// The heuristic's depends_on target must be a real sibling slug — the
// cross-Story validator rejects a depends_on edge to an unknown slug — so these
// fixtures depend on SIBLING_FILLER ('s-sizing-filler').
// ---------------------------------------------------------------------------

test('fires on a tiny chained Story (soft, never in errors[])', () => {
  const story = makeStory('t-merge-fires', {
    changes: ['src/a.js: edit', 'src/b.js: edit'],
    acceptance: ['criterion 1', 'criterion 2'],
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);

  const merge = result.findings.filter((f) => f.kind === 'merge-candidate');
  assert.equal(merge.length, 1);
  assert.equal(merge[0].severity, 'soft');
  assert.equal(merge[0].ticketSlug, 't-merge-fires');
  assert.equal(merge[0].fileCount, 2);
  assert.equal(merge[0].acceptanceCount, 2);
  assert.deepEqual(merge[0].dependsOn, ['s-sizing-filler']);
  // Advisory only: never a hard finding, never an error.
  const hard = result.findings.filter((f) => f.severity === 'hard');
  assert.deepEqual(hard, []);
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
  assert.ok(merge, 'expected a merge-candidate finding');
  assert.match(merge.message, /s-sizing-filler/);
  assert.match(merge.message, /merg/i);
});

test('silent on a tiny ORPHAN Story (no depends_on edge)', () => {
  // Same tiny footprint, but no depends_on — a legitimate small orthogonal
  // slice. Must NOT trip the finding.
  const result = validateStory(
    makeStory('t-merge-orphan', {
      changes: ['src/a.js: edit', 'src/b.js: edit'],
      acceptance: ['criterion 1', 'criterion 2'],
    }),
  );
  const merge = result.findings.filter((f) => f.kind === 'merge-candidate');
  assert.deepEqual(merge, []);
});

test('silent on a normal-sized chained Story (footprint above the ceiling)', () => {
  // A chained Story whose file footprint exceeds mergeCandidateMaxFiles (3) is
  // a real capability slice, not a fragment — no finding despite the edge.
  const story = makeStory('t-merge-normal-files', {
    changes: [
      'src/a.js: edit',
      'src/b.js: edit',
      'src/c.js: edit',
      'src/d.js: edit',
    ],
    acceptance: ['criterion 1', 'criterion 2'],
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);
  const merge = result.findings.filter((f) => f.kind === 'merge-candidate');
  assert.deepEqual(merge, []);
});

test('silent on a chained Story whose acceptance count exceeds the ceiling', () => {
  // Tiny file footprint + a depends_on edge, but 5 acceptance items (> 4): the
  // acceptance axis alone keeps it out of merge-candidate territory.
  const story = makeStory('t-merge-normal-ac', {
    changes: ['src/a.js: edit'],
    acceptance: Array.from({ length: 5 }, (_, i) => `criterion ${i}`),
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);
  const merge = result.findings.filter((f) => f.kind === 'merge-candidate');
  assert.deepEqual(merge, []);
});

test('respects a planning.taskSizing threshold override', () => {
  // A Story with 4 files + a depends_on edge: silent under the default
  // mergeCandidateMaxFiles=3, but flagged when the operator raises the ceiling
  // to 4 via planning.taskSizing.
  const makeFourFileChained = (slug) => {
    const s = makeStory(slug, {
      changes: [
        'src/a.js: edit',
        'src/b.js: edit',
        'src/c.js: edit',
        'src/d.js: edit',
      ],
      acceptance: ['criterion 1'],
    });
    s.depends_on = ['s-sizing-filler'];
    return s;
  };

  const defaultResult = validateStory(makeFourFileChained('t-merge-default'));
  assert.deepEqual(
    defaultResult.findings.filter((f) => f.kind === 'merge-candidate'),
    [],
    'default mergeCandidateMaxFiles=3 leaves a 4-file Story silent',
  );

  const overrideResult = validateStory(
    makeFourFileChained('t-merge-override'),
    { taskSizing: { mergeCandidateMaxFiles: 4 } },
  );
  const merge = overrideResult.findings.filter(
    (f) => f.kind === 'merge-candidate',
  );
  assert.equal(
    merge.length,
    1,
    'raising mergeCandidateMaxFiles to 4 flags the 4-file Story',
  );
  assert.equal(merge[0].fileCount, 4);
});

test('silent on a chained Story that carries a glob change (unknown width)', () => {
  // A glob makes the footprint unknown-width; a merge candidate must have a
  // known, small footprint, so a glob-carrying Story is never flagged.
  const story = makeStory('t-merge-glob', {
    changes: ['**/*.ts: update imports'],
    acceptance: ['criterion 1'],
  });
  story.depends_on = ['s-sizing-filler'];
  const result = validateStory(story);
  const merge = result.findings.filter((f) => f.kind === 'merge-candidate');
  assert.deepEqual(merge, []);
});
