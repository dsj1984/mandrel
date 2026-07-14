// tests/lib/story-body/story-body.test.js
/**
 * Unit tests for the canonical Story-body parser/serializer.
 *
 * Covers:
 *   - parse(): markdown → structured object (canonical sections)
 *   - parse(): structured object passthrough
 *   - parse(): legacy string body fallback
 *   - parse(): `blocked by` footer → depends_on extraction
 *   - parse(): legacy-path-entry warning for string-form changes
 *   - parse(): object-form PathEntry (canonical)
 *   - parse(): malformed PathEntry throws StoryBodyParseError
 *   - parse(): null/undefined input throws
 *   - serialize(): structured object → markdown
 *   - serialize(): includes footer when opts.includeFooter = true
 *   - serialize(): meta comment block for wide / estimated_test_files
 *   - serialize(): omits empty sections
 *   - parse()/serialize(): optional `## Spec` folded Tech Spec text block
 *   - extractChangePaths(): flags glob entries
 *   - round-trip: parse(serialize(body)) reproduces body
 *   - test-surface-unestimated warning on absent estimated_test_files
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractChangePaths,
  parse,
  StoryBodyParseError,
  serialize,
} from '../../../.agents/scripts/lib/story-body/story-body.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL_MARKDOWN = `## Goal
Create the shared canonical Story-body parser/serializer.

## Changes
- ${JSON.stringify({ path: '.agents/scripts/lib/story-body/story-body.js', assumption: 'creates' })}
- ${JSON.stringify({ path: 'tests/lib/story-body/story-body.test.js', assumption: 'creates' })}

## Acceptance
- [ ] parse() returns a StoryBody with all sections populated
- [ ] serialize(parse(md)) round-trips cleanly

## Verify
- npm test -- tests/lib/story-body/story-body.test.js (unit)`;

const CANONICAL_BODY = {
  goal: 'Create the shared canonical Story-body parser/serializer.',
  changes: [
    {
      path: '.agents/scripts/lib/story-body/story-body.js',
      assumption: 'creates',
    },
    {
      path: 'tests/lib/story-body/story-body.test.js',
      assumption: 'creates',
    },
  ],
  acceptance: [
    'parse() returns a StoryBody with all sections populated',
    'serialize(parse(md)) round-trips cleanly',
  ],
  verify: ['npm test -- tests/lib/story-body/story-body.test.js (unit)'],
  references: [],
  wide: null,
  depends_on: [],
  estimated_test_files: null,
};

// ---------------------------------------------------------------------------
// parse() — markdown input
// ---------------------------------------------------------------------------

describe('parse() — markdown', () => {
  it('returns all canonical sections from well-formed markdown', () => {
    const { body, info } = parse(CANONICAL_MARKDOWN);
    assert.equal(
      body.goal,
      'Create the shared canonical Story-body parser/serializer.',
    );
    assert.equal(body.changes.length, 2);
    assert.equal(body.acceptance.length, 2);
    assert.equal(body.verify.length, 1);
    assert.equal(body.references.length, 0);
    assert.equal(info.hasGoalSection, true);
    assert.equal(info.hasChangesSection, true);
    assert.equal(info.hasAcceptanceSection, true);
    assert.equal(info.hasVerifySection, true);
    assert.equal(info.isLegacyStringBody, false);
  });

  it('parses canonical PathEntry objects from changes', () => {
    const { body } = parse(CANONICAL_MARKDOWN);
    const first = body.changes[0];
    assert.deepEqual(first, {
      path: '.agents/scripts/lib/story-body/story-body.js',
      assumption: 'creates',
    });
  });

  it('extracts depends_on from `blocked by` footer lines', () => {
    const md = `${CANONICAL_MARKDOWN}\n\n---\nparent: #3225\nEpic: #3211\nblocked by #3229\nblocked by #3228`;
    const { body } = parse(md);
    assert.deepEqual(body.depends_on, ['#3229', '#3228']);
  });

  it('returns empty depends_on when no footer is present', () => {
    const { body } = parse(CANONICAL_MARKDOWN);
    assert.deepEqual(body.depends_on, []);
  });

  it('emits test-surface-unestimated warning when estimated_test_files absent', () => {
    const { warnings } = parse(CANONICAL_MARKDOWN);
    assert.ok(
      warnings.some((w) => w.startsWith('test-surface-unestimated')),
      `expected test-surface-unestimated warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('sets estimated_test_files to null for markdown bodies', () => {
    const { body } = parse(CANONICAL_MARKDOWN);
    assert.equal(body.estimated_test_files, null);
  });

  it('sets wide to null when not present in markdown', () => {
    const { body } = parse(CANONICAL_MARKDOWN);
    assert.equal(body.wide, null);
  });

  it('does not bleed a trailing unrecognized heading into the prior section', () => {
    // A canonical body followed by a free-form, single-word `## Notes`
    // section (a heading that matches the canonical `## Word` shape but is
    // not a recognized field). Before the fix, the unknown heading + its
    // bullets bled into the previously-open `verify` section, corrupting
    // `verify[]`. The fix resets currentSection to null on the unrecognized
    // heading so the trailing section is dropped, not appended.
    const md = `${CANONICAL_MARKDOWN}

## Notes
- not touching b.js
- some other negative bound`;
    const { body } = parse(md);
    // The recognized sections stay clean — the unknown heading and its
    // bullets are dropped, not appended to verify[] / acceptance[].
    assert.deepEqual(body.verify, [
      'npm test -- tests/lib/story-body/story-body.test.js (unit)',
    ]);
    assert.deepEqual(body.acceptance, [
      'parse() returns a StoryBody with all sections populated',
      'serialize(parse(md)) round-trips cleanly',
    ]);
  });

  it('still registers a recognized heading that follows an unrecognized one', () => {
    // A single-word unknown heading between Goal and Verify must close the
    // Goal section without re-entering the preamble, so the later
    // `## Verify` still registers normally.
    const md = `## Goal
Do the thing.

## Notes
- nope

## Verify
- npm test (unit)`;
    const { body } = parse(md);
    assert.equal(body.goal, 'Do the thing.');
    assert.deepEqual(body.verify, ['npm test (unit)']);
  });
});

// ---------------------------------------------------------------------------
// parse() — legacy string-form changes
// ---------------------------------------------------------------------------

describe('parse() — legacy path entries', () => {
  it('emits legacy-path-entry warning for bare string bullets', () => {
    const md = `## Goal\nWire X to Y.\n\n## Changes\n- src/foo.js: extract handler\n\n## Acceptance\n- [ ] it works\n\n## Verify\n- npm test (unit)`;
    const { body, warnings } = parse(md);
    assert.equal(body.changes.length, 1);
    assert.equal(typeof body.changes[0], 'string');
    assert.ok(
      warnings.some((w) => w.startsWith('legacy-path-entry')),
      `expected legacy-path-entry warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it('includes the string entry in changes even for legacy form', () => {
    const md = `## Goal\nDo X.\n\n## Changes\n- src/legacy.js: rewrite\n\n## Acceptance\n- [ ] pass\n\n## Verify\n- npm test (unit)`;
    const { body } = parse(md);
    assert.equal(body.changes[0], 'src/legacy.js: rewrite');
  });
});

// ---------------------------------------------------------------------------
// parse() — legacy string body
// ---------------------------------------------------------------------------

describe('parse() — legacy string body (no sections)', () => {
  it('returns minimal body from preamble text', () => {
    const md =
      'Create the shared canonical Story-body parser.\n\n---\nparent: #3225\nEpic: #3211';
    const { body, info, warnings } = parse(md);
    assert.ok(body.goal.length > 0);
    assert.equal(info.isLegacyStringBody, true);
    assert.ok(warnings.some((w) => w.startsWith('legacy-string-body')));
  });

  it('extracts depends_on from footer even for legacy string body', () => {
    const md =
      'Some freeform text.\n\n---\nparent: #3225\nEpic: #3211\nblocked by #100';
    const { body } = parse(md);
    assert.deepEqual(body.depends_on, ['#100']);
  });
});

// ---------------------------------------------------------------------------
// parse() — structured object input
// ---------------------------------------------------------------------------

describe('parse() — structured object input', () => {
  it('normalises a decomposer-emitted structured object', () => {
    const obj = {
      goal: 'Wire X to Y.',
      changes: [
        { path: 'src/foo.js', assumption: 'creates' },
        'src/bar.js: edit',
      ],
      acceptance: ['foo test passes'],
      verify: ['npm test (unit)'],
      depends_on: ['story-abc'],
      wide: { reason: 'mechanical sweep across every consumer site' },
    };
    const { body, warnings } = parse(obj);
    assert.equal(body.goal, 'Wire X to Y.');
    assert.deepEqual(body.changes[0], {
      path: 'src/foo.js',
      assumption: 'creates',
    });
    assert.equal(typeof body.changes[1], 'string'); // legacy warning
    assert.ok(warnings.some((w) => w.startsWith('legacy-path-entry')));
    assert.deepEqual(body.wide, {
      reason: 'mechanical sweep across every consumer site',
    });
    assert.deepEqual(body.depends_on, ['story-abc']);
    assert.equal(body.estimated_test_files, null);
  });

  it('preserves numeric estimated_test_files', () => {
    const obj = {
      goal: 'X.',
      changes: [],
      acceptance: [],
      verify: [],
      estimated_test_files: 5,
    };
    const { body, warnings } = parse(obj);
    assert.equal(body.estimated_test_files, 5);
    assert.ok(!warnings.some((w) => w.startsWith('test-surface-unestimated')));
  });

  it('normalises references to PathEntry objects', () => {
    const obj = {
      goal: 'X.',
      changes: [],
      acceptance: [],
      verify: [],
      references: [{ path: 'docs/foo.md', assumption: 'exists' }],
    };
    const { body } = parse(obj);
    assert.deepEqual(body.references, [
      { path: 'docs/foo.md', assumption: 'exists' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// parse() — error cases
// ---------------------------------------------------------------------------

describe('parse() — error cases', () => {
  it('throws StoryBodyParseError for null input', () => {
    assert.throws(() => parse(null), StoryBodyParseError);
  });

  it('throws StoryBodyParseError for undefined input', () => {
    assert.throws(() => parse(undefined), StoryBodyParseError);
  });

  it('throws StoryBodyParseError for numeric input', () => {
    assert.throws(() => parse(42), StoryBodyParseError);
  });

  it('throws StoryBodyParseError for malformed object PathEntry in changes', () => {
    const obj = {
      goal: 'X.',
      changes: [{ path: 'src/foo.js', assumption: 'invalid-assumption' }],
      acceptance: [],
      verify: [],
    };
    assert.throws(() => parse(obj), StoryBodyParseError);
  });

  it('throws StoryBodyParseError for malformed object PathEntry in markdown changes', () => {
    const md = `## Goal\nX.\n\n## Changes\n- {"path":"src/foo.js","assumption":"not-valid"}\n\n## Acceptance\n- [ ] pass\n\n## Verify\n- npm test (unit)`;
    assert.throws(() => parse(md), StoryBodyParseError);
  });
});

// ---------------------------------------------------------------------------
// serialize()
// ---------------------------------------------------------------------------

describe('serialize()', () => {
  it('emits ## Goal, ## Changes, ## Acceptance, ## Verify sections', () => {
    const out = serialize(CANONICAL_BODY);
    assert.ok(out.includes('## Goal\n'));
    assert.ok(out.includes('## Changes\n'));
    assert.ok(out.includes('## Acceptance\n'));
    assert.ok(out.includes('## Verify\n'));
  });

  it('omits ## References section when empty', () => {
    const out = serialize(CANONICAL_BODY);
    assert.ok(!out.includes('## References'));
  });

  it('includes ## References when non-empty', () => {
    const body = {
      ...CANONICAL_BODY,
      references: [{ path: 'docs/arch.md', assumption: 'exists' }],
    };
    const out = serialize(body);
    assert.ok(out.includes('## References'));
    assert.ok(out.includes('docs/arch.md'));
  });

  it('emits acceptance items with `- [ ]` prefix', () => {
    const out = serialize(CANONICAL_BODY);
    assert.ok(out.includes('- [ ] parse() returns'));
  });

  it('includes footer when opts.includeFooter = true', () => {
    const out = serialize(CANONICAL_BODY, {
      includeFooter: true,
      footer: { parent: 3225, epic: 3211 },
    });
    assert.ok(out.includes('---'));
    assert.ok(out.includes('parent: #3225'));
    assert.ok(out.includes('Epic: #3211'));
  });

  it('includes `blocked by` lines in footer for non-empty depends_on', () => {
    const body = { ...CANONICAL_BODY, depends_on: ['#100', '#200'] };
    const out = serialize(body, {
      includeFooter: true,
      footer: { epic: 3211 },
    });
    assert.ok(out.includes('blocked by #100'));
    assert.ok(out.includes('blocked by #200'));
  });

  it('emits meta comment block for wide', () => {
    const body = {
      ...CANONICAL_BODY,
      wide: { reason: 'broad cutover for one reason' },
    };
    const out = serialize(body);
    assert.ok(out.includes('<!-- meta:'));
    assert.ok(out.includes('"wide":{"reason":"broad cutover for one reason"}'));
  });

  it('emits meta comment block for estimated_test_files', () => {
    const body = { ...CANONICAL_BODY, estimated_test_files: 7 };
    const out = serialize(body);
    assert.ok(out.includes('<!-- meta:'));
    assert.ok(out.includes('"estimated_test_files":7'));
  });

  it('throws StoryBodyParseError for null body', () => {
    assert.throws(() => serialize(null), StoryBodyParseError);
  });
});

// ---------------------------------------------------------------------------
// extractChangePaths()
// ---------------------------------------------------------------------------

describe('extractChangePaths()', () => {
  it('returns path strings from PathEntry objects', () => {
    const changes = [
      { path: 'src/foo.js', assumption: 'creates' },
      { path: 'src/bar.js', assumption: 'refactors-existing' },
    ];
    const paths = extractChangePaths(changes);
    assert.deepEqual(paths, [
      { path: 'src/foo.js', isGlob: false },
      { path: 'src/bar.js', isGlob: false },
    ]);
  });

  it('flags glob-bearing paths as isGlob: true', () => {
    const changes = [
      { path: 'tests/**/*.test.js', assumption: 'exists' },
      { path: 'src/foo.js', assumption: 'creates' },
    ];
    const paths = extractChangePaths(changes);
    assert.equal(paths[0].isGlob, true);
    assert.equal(paths[1].isGlob, false);
  });

  it('handles legacy string-form entries', () => {
    const changes = ['src/foo.js: edit'];
    const paths = extractChangePaths(changes);
    assert.equal(paths[0].path, 'src/foo.js: edit');
    assert.equal(paths[0].isGlob, false);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(extractChangePaths(null), []);
    assert.deepEqual(extractChangePaths(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('round-trip: serialize → parse', () => {
  it('round-trips a full canonical body through serialize/parse', () => {
    const body = {
      goal: 'Implement the canonical parser.',
      changes: [
        {
          path: '.agents/scripts/lib/story-body/story-body.js',
          assumption: 'creates',
        },
      ],
      acceptance: ['All tests pass'],
      verify: ['npm test (unit)'],
      references: [{ path: 'docs/arch.md', assumption: 'exists' }],
      wide: null,
      depends_on: [],
      estimated_test_files: null,
    };
    const md = serialize(body);
    const { body: reparsed } = parse(md);

    assert.equal(reparsed.goal, body.goal);
    assert.deepEqual(reparsed.changes, body.changes);
    assert.deepEqual(reparsed.acceptance, body.acceptance);
    assert.deepEqual(reparsed.verify, body.verify);
    assert.deepEqual(reparsed.references, body.references);
    assert.deepEqual(reparsed.depends_on, body.depends_on);
  });
});

describe('non_goals (advisory negative-scope section)', () => {
  it('round-trips a body WITH non_goals populated through serialize/parse', () => {
    const body = {
      goal: 'Add an optional negative-scope section.',
      changes: [
        {
          path: '.agents/scripts/lib/story-body/story-body.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: ['non_goals round-trips'],
      verify: ['node --test (unit)'],
      references: [],
      non_goals: [
        'Making non_goals validator-gating',
        'Migrating existing standalone bodies',
      ],
      wide: null,
      reason_to_exist: null,
      depends_on: [],
      estimated_test_files: null,
    };
    const md = serialize(body);
    // The hyphenated canonical heading is emitted.
    assert.match(md, /^## Non-Goals$/m);
    const { body: reparsed, info } = parse(md);
    assert.deepEqual(reparsed.non_goals, body.non_goals);
    assert.equal(info.hasNonGoalsSection, true);
  });

  it('round-trips a body WITHOUT non_goals (empty) byte-identically', () => {
    const body = {
      goal: 'No negative-scope bounds here.',
      changes: [{ path: 'lib/x.js', assumption: 'creates' }],
      acceptance: ['it works'],
      verify: ['node --test (unit)'],
      references: [],
      non_goals: [],
      wide: null,
      reason_to_exist: null,
      depends_on: [],
      estimated_test_files: null,
    };
    const md = serialize(body);
    // An empty non_goals emits no section — the body must be byte-identical
    // to the same body serialized without the field at all.
    const { non_goals, ...withoutNonGoals } = body;
    assert.equal(serialize(withoutNonGoals), md);
    assert.equal(/## Non-Goals/.test(md), false);

    const { body: reparsed, info } = parse(md);
    assert.deepEqual(reparsed.non_goals, []);
    assert.equal(info.hasNonGoalsSection, false);
  });

  it('parses the canonical ## Non-Goals heading into non_goals[]', () => {
    const md = `## Goal
g

## Non-Goals
- do not touch the validator
- do not migrate existing bodies`;
    const { body, info } = parse(md);
    assert.deepEqual(body.non_goals, [
      'do not touch the validator',
      'do not migrate existing bodies',
    ]);
    assert.equal(info.hasNonGoalsSection, true);
  });

  it('does NOT treat a non_goals-only body as legacy (predicate unchanged)', () => {
    // isLegacyStringBody keys off goal/changes/acceptance/verify only — a body
    // carrying ONLY a ## Non-Goals section and none of those is still a legacy
    // string body, proving non_goals was not added to the predicate.
    const md = `## Non-Goals
- nothing structured here`;
    const { info } = parse(md);
    assert.equal(info.isLegacyStringBody, true);
  });
});

describe('parse(): per-section sub-parser behavior', () => {
  it('joins multi-line goal content into a single one-line string', () => {
    const md = `## Goal
First clause
second clause

## Acceptance
- [ ] something`;
    const { body } = parse(md);
    assert.equal(body.goal, 'First clause second clause');
  });

  it('drops blank acceptance/verify bullets and strips checkbox markers', () => {
    const md = `## Goal
g

## Acceptance
- [ ] first criterion
- [x] second criterion

## Verify
- npm test (unit)
-   `;
    const { body } = parse(md);
    assert.deepEqual(body.acceptance, ['first criterion', 'second criterion']);
    assert.deepEqual(body.verify, ['npm test (unit)']);
  });

  it('stops a structured section at an unrecognized heading (extended content does not bleed in)', () => {
    // Story #4270: producers (audit-to-stories) append non-canonical
    // `## Agent Prompts` / `## Context` blocks after the canonical sections.
    // Those headings — single- or multi-word — must terminate the prior
    // section so their lines are not absorbed into verify[] / acceptance[].
    const md = `## Goal
g

## Acceptance
- [ ] observable outcome

## Verify
- npm run lint (validate)
- npm test (unit)

## Agent Prompts

**Some finding**

\`\`\`
do the thing
\`\`\`

## Context

linked report`;
    const { body } = parse(md);
    assert.deepEqual(body.verify, [
      'npm run lint (validate)',
      'npm test (unit)',
    ]);
    assert.deepEqual(body.acceptance, ['observable outcome']);
  });

  it('parses a mix of object-form and legacy-string change entries', () => {
    const md = `## Goal
g

## Changes
- ${JSON.stringify({ path: 'src/a.js', assumption: 'creates' })}
- src/b.js: legacy bullet

## Acceptance
- [ ] x`;
    const { body, warnings } = parse(md);
    assert.deepEqual(body.changes, [
      { path: 'src/a.js', assumption: 'creates' },
      'src/b.js: legacy bullet',
    ]);
    assert.ok(
      warnings.some((w) => w.startsWith('legacy-path-entry:')),
      'expected a legacy-path-entry warning for the string-form bullet',
    );
  });

  it('parses object-form reference entries', () => {
    const md = `## Goal
g

## Acceptance
- [ ] x

## References
- ${JSON.stringify({ path: 'docs/arch.md', assumption: 'exists' })}`;
    const { body, info } = parse(md);
    assert.equal(info.hasReferencesSection, true);
    assert.deepEqual(body.references, [
      { path: 'docs/arch.md', assumption: 'exists' },
    ]);
  });

  it('returns the legacy-string-body shape when no structured sections exist', () => {
    const md = `Just a plain prose body with no headings.

---
blocked by #42`;
    const { body, info, warnings } = parse(md);
    assert.equal(info.isLegacyStringBody, true);
    assert.equal(body.goal, 'Just a plain prose body with no headings.');
    assert.deepEqual(body.changes, []);
    assert.deepEqual(body.acceptance, []);
    assert.deepEqual(body.verify, []);
    assert.deepEqual(body.references, []);
    assert.equal(body.wide, null);
    assert.equal(body.estimated_test_files, null);
    assert.deepEqual(body.depends_on, ['#42']);
    assert.ok(warnings.some((w) => w.startsWith('legacy-string-body:')));
  });
});

// ---------------------------------------------------------------------------
// v2 — optional `## Slicing` section (intra-Story delivery slice plan)
// ---------------------------------------------------------------------------

describe('parse()/serialize() — v2 `## Slicing` section', () => {
  const SLICING_MARKDOWN = `## Goal
Deliver the widget end to end.

## Slicing
- slice 1: schema + migration
- slice 2: API handler on the schema
- slice 3: UI wired to the API

## Changes
- ${JSON.stringify({ path: 'src/widget.ts', assumption: 'creates' })}

## Acceptance
- [ ] widget renders

## Verify
- npm test (unit)`;

  it('parse() captures the slice plan verbatim and flags the section', () => {
    const { body, info } = parse(SLICING_MARKDOWN);
    assert.equal(
      body.slicing,
      '- slice 1: schema + migration\n- slice 2: API handler on the schema\n- slice 3: UI wired to the API',
    );
    assert.equal(info.hasSlicingSection, true);
  });

  it('parse() yields empty slicing and false flag when the section is absent', () => {
    const { body, info } = parse(CANONICAL_MARKDOWN);
    assert.equal(body.slicing, '');
    assert.equal(info.hasSlicingSection, false);
  });

  it('serialize() emits `## Slicing` right after `## Goal` when present', () => {
    const md = serialize({
      goal: 'g',
      slicing: '- slice 1: do the thing',
      changes: [{ path: 'src/a.ts', assumption: 'creates' }],
      acceptance: ['done'],
      verify: ['npm test (unit)'],
    });
    assert.match(
      md,
      /## Goal\ng\n\n## Slicing\n- slice 1: do the thing\n\n## Changes/,
    );
  });

  it('serialize() omits the section for a pre-v2 body (byte-identical)', () => {
    const withoutField = serialize(CANONICAL_BODY);
    const withEmptyField = serialize({ ...CANONICAL_BODY, slicing: '' });
    assert.equal(withEmptyField, withoutField);
    assert.doesNotMatch(withoutField, /## Slicing/);
  });

  it('round-trips: parse(serialize(body)) preserves the slice plan', () => {
    const { body } = parse(SLICING_MARKDOWN);
    const reparsed = parse(serialize(body)).body;
    assert.equal(reparsed.slicing, body.slicing);
    assert.equal(serialize(reparsed), serialize(body));
  });

  it('structured-object parse preserves an inline slicing string', () => {
    const { body } = parse({
      goal: 'g',
      slicing: '- slice 1: x',
      changes: [{ path: 'src/a.ts', assumption: 'creates' }],
      acceptance: ['a'],
      verify: ['npm test (unit)'],
    });
    assert.equal(body.slicing, '- slice 1: x');
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — optional `## Spec` section (folded Tech Spec)
// ---------------------------------------------------------------------------

describe('parse()/serialize() — `## Spec` section', () => {
  const SPEC_MARKDOWN = `## Goal
Deliver the widget end to end.

## Slicing
- slice 1: schema + migration

## Spec
Use the existing widget repository seam.
- Persist widget state through the existing store.
- Reuse the current route registration flow.

## Changes
- ${JSON.stringify({ path: 'src/widget.ts', assumption: 'creates' })}

## Acceptance
- [ ] widget renders

## Verify
- npm test (unit)`;

  it('parse() captures the folded Tech Spec verbatim and flags the section', () => {
    const { body, info } = parse(SPEC_MARKDOWN);
    assert.equal(
      body.spec,
      'Use the existing widget repository seam.\n- Persist widget state through the existing store.\n- Reuse the current route registration flow.',
    );
    assert.equal(info.hasSpecSection, true);
  });

  it('parse() yields empty spec and false flag when the section is absent', () => {
    const { body, info } = parse(CANONICAL_MARKDOWN);
    assert.equal(body.spec, '');
    assert.equal(info.hasSpecSection, false);
  });

  it('serialize() emits `## Spec` after `## Slicing` and before `## Changes` when present', () => {
    const md = serialize({
      goal: 'g',
      slicing: '- slice 1: do the thing',
      spec: 'Implementation notes\n- Keep the existing seam',
      changes: [{ path: 'src/a.ts', assumption: 'creates' }],
      acceptance: ['done'],
      verify: ['npm test (unit)'],
    });
    assert.match(
      md,
      /## Goal\ng\n\n## Slicing\n- slice 1: do the thing\n\n## Spec\nImplementation notes\n- Keep the existing seam\n\n## Changes/,
    );
  });

  it('serialize() omits absent or empty spec so pre-v2 bodies round-trip byte-identically', () => {
    const withoutField = serialize(CANONICAL_BODY);
    const withEmptyField = serialize({ ...CANONICAL_BODY, spec: '' });
    assert.equal(withEmptyField, withoutField);
    assert.doesNotMatch(withoutField, /## Spec/);
    assert.equal(serialize(parse(CANONICAL_MARKDOWN).body), CANONICAL_MARKDOWN);
  });

  it('round-trips: parse(serialize(body)) preserves the folded Tech Spec', () => {
    const { body } = parse(SPEC_MARKDOWN);
    const reparsed = parse(serialize(body)).body;
    assert.equal(reparsed.spec, body.spec);
    assert.equal(serialize(reparsed), serialize(body));
  });

  it('preserves nested headings and interior blank lines inside the folded spec', () => {
    const markdown = `## Goal
Ship the widget.

## Spec
Overview paragraph.

## Architecture
Use the existing repository.

### Risks
- Migration ordering.

## Acceptance
- [ ] widget ships

## Verify
- npm test (unit)`;
    const { body } = parse(markdown);
    assert.equal(
      body.spec,
      [
        'Overview paragraph.',
        '',
        '## Architecture',
        'Use the existing repository.',
        '',
        '### Risks',
        '- Migration ordering.',
      ].join('\n'),
    );
    assert.deepEqual(body.acceptance, ['widget ships']);
  });

  it('structured-object parse preserves an inline spec string', () => {
    const { body, info } = parse({
      goal: 'g',
      spec: 'Use the existing story-body serializer.',
      changes: [{ path: 'src/a.ts', assumption: 'creates' }],
      acceptance: ['a'],
      verify: ['npm test (unit)'],
    });
    assert.equal(body.spec, 'Use the existing story-body serializer.');
    assert.equal(info.hasSpecSection, true);
  });
});
