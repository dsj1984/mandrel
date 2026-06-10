import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectStoryAssumptionEntries,
  FILE_ASSUMPTION_VALUES,
  hasLegacyChangeBullets,
  validateStoryFileAssumptions,
} from '../.agents/scripts/lib/orchestration/file-assumptions.js';
import {
  isMalformedObjectPathEntry,
  isObjectPathEntry,
  validateTaskBodyShape,
} from '../.agents/scripts/lib/orchestration/task-body-validator.js';

/**
 * Story #2636 — Phase 8 path-assumption gate.
 *
 * Story #3276 reworked the gate onto the 3-tier Story inline contract:
 * the validator inspects each Story's body.changes and body.references
 * for object-form `{ path, assumption }` entries and verifies them
 * against `baseBranchRef`. Legacy string-form bullets are tolerated and
 * emit a one-time deprecation warning per Story.
 */

function makeStory({ slug = 'demo-story', body }) {
  return { type: 'story', slug, title: slug, body };
}

describe('isObjectPathEntry / isMalformedObjectPathEntry — schema guards', () => {
  it('accepts every assumption from the canonical enum', () => {
    for (const assumption of FILE_ASSUMPTION_VALUES) {
      assert.equal(
        isObjectPathEntry({ path: 'src/x.ts', assumption }),
        true,
        `expected ${assumption} to be valid`,
      );
    }
  });

  it('rejects an entry missing the path field', () => {
    assert.equal(isObjectPathEntry({ assumption: 'creates' }), false);
    assert.equal(isMalformedObjectPathEntry({ assumption: 'creates' }), true);
  });

  it('rejects an entry with an unknown assumption value', () => {
    const entry = { path: 'src/x.ts', assumption: 'rewires' };
    assert.equal(isObjectPathEntry(entry), false);
    assert.equal(isMalformedObjectPathEntry(entry), true);
  });

  it('treats string bullets as non-objects (not malformed)', () => {
    assert.equal(isMalformedObjectPathEntry('src/x.ts: extract foo'), false);
    assert.equal(isObjectPathEntry('src/x.ts: extract foo'), false);
  });
});

describe('validateTaskBodyShape — object-form changes + references', () => {
  it('accepts a body whose changes are pure object-form entries', () => {
    const errors = validateTaskBodyShape(
      makeStory({
        body: {
          goal: 'extract verifyToken',
          changes: [
            { path: 'src/auth/verifyToken.ts', assumption: 'creates' },
            { path: 'src/auth/index.ts', assumption: 'refactors-existing' },
          ],
          acceptance: ['unit test covers verifyToken happy path'],
          verify: ['npm test -- --grep verifyToken (unit)'],
        },
      }),
    );
    assert.deepEqual(errors, []);
  });

  it('rejects a malformed object entry with an unknown assumption', () => {
    const errors = validateTaskBodyShape(
      makeStory({
        body: {
          goal: 'extract verifyToken',
          changes: [{ path: 'src/auth.ts', assumption: 'rewires' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    );
    assert.equal(errors.length, 2);
    assert.match(errors[0], /name no path-shaped token/);
    assert.match(errors[1], /assumption: one of/);
  });

  it('accepts a body.references array of object entries', () => {
    const errors = validateTaskBodyShape(
      makeStory({
        body: {
          goal: 'g',
          changes: ['src/x.ts: edit'],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
          references: [
            { path: 'tests/features/login.feature', assumption: 'exists' },
          ],
        },
      }),
    );
    assert.deepEqual(errors, []);
  });

  it('rejects a body.references that is not an array', () => {
    const errors = validateTaskBodyShape(
      makeStory({
        body: {
          goal: 'g',
          changes: ['src/x.ts: edit'],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
          references: 'not-an-array',
        },
      }),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /body\.references must be an array/);
  });
});

describe('collectStoryAssumptionEntries — extraction helper', () => {
  it('walks changes and references and tags each entry with its source', () => {
    const entries = collectStoryAssumptionEntries(
      makeStory({
        body: {
          goal: 'g',
          changes: [
            { path: 'src/a.ts', assumption: 'creates' },
            'src/b.ts: edit',
          ],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
          references: [{ path: 'tests/x.feature', assumption: 'exists' }],
        },
      }),
    );
    assert.deepEqual(entries, [
      { path: 'src/a.ts', assumption: 'creates', source: 'changes' },
      { path: 'tests/x.feature', assumption: 'exists', source: 'references' },
    ]);
  });

  it('returns empty when no object entries are present', () => {
    const entries = collectStoryAssumptionEntries(
      makeStory({
        body: {
          goal: 'g',
          changes: ['src/x.ts: legacy bullet'],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    );
    assert.deepEqual(entries, []);
  });
});

describe('hasLegacyChangeBullets — partial migration cue', () => {
  it('returns true when any change entry is still a string', () => {
    const story = makeStory({
      body: {
        goal: 'g',
        changes: [
          { path: 'src/a.ts', assumption: 'creates' },
          'src/b.ts: legacy',
        ],
        acceptance: ['ac'],
        verify: ['v'],
      },
    });
    assert.equal(hasLegacyChangeBullets(story), true);
  });

  it('returns false when every change is object-form', () => {
    const story = makeStory({
      body: {
        goal: 'g',
        changes: [{ path: 'src/a.ts', assumption: 'creates' }],
        acceptance: ['ac'],
        verify: ['v'],
      },
    });
    assert.equal(hasLegacyChangeBullets(story), false);
  });
});

describe('validateStoryFileAssumptions — rules table', () => {
  // Each row exercises one (assumption × actual-state) combination.
  const cases = [
    {
      label: 'creates + absent → ok',
      assumption: 'creates',
      exists: false,
      expectError: false,
    },
    {
      label: 'creates + present → error',
      assumption: 'creates',
      exists: true,
      expectError: true,
      expected: 'absent',
    },
    {
      label: 'refactors-existing + present → ok',
      assumption: 'refactors-existing',
      exists: true,
      expectError: false,
    },
    {
      label: 'refactors-existing + absent → error',
      assumption: 'refactors-existing',
      exists: false,
      expectError: true,
      expected: 'present',
    },
    {
      label: 'exists + present → ok',
      assumption: 'exists',
      exists: true,
      expectError: false,
    },
    {
      label: 'exists + absent → error',
      assumption: 'exists',
      exists: false,
      expectError: true,
      expected: 'present',
    },
    {
      label: 'deletes + present → ok',
      assumption: 'deletes',
      exists: true,
      expectError: false,
    },
    {
      label: 'deletes + absent → error',
      assumption: 'deletes',
      exists: false,
      expectError: true,
      expected: 'present',
    },
  ];

  for (const tc of cases) {
    it(tc.label, () => {
      const tickets = [
        makeStory({
          body: {
            goal: 'g',
            changes: [{ path: 'src/sample.ts', assumption: tc.assumption }],
            acceptance: ['ac'],
            verify: ['node --test tests/x.test.js (unit)'],
          },
        }),
      ];
      const report = validateStoryFileAssumptions({
        tickets,
        baseBranchRef: 'main',
        gitRunner: () => tc.exists,
      });
      if (tc.expectError) {
        assert.equal(report.errors.length, 1);
        assert.equal(report.mismatches[0].expected, tc.expected);
      } else {
        assert.deepEqual(report.errors, []);
      }
    });
  }

  it('only scans type==="story" tickets — Features and Epics are skipped', () => {
    // 3-tier regression (Story #3276): the gate partitions on the Story
    // tier. A non-Story ticket carrying a mismatched assumption must be
    // ignored so the gate never fires on narrative Feature/Epic bodies.
    const tickets = [
      {
        type: 'feature',
        slug: 'a-feature',
        title: 'a-feature',
        body: {
          goal: 'g',
          // `creates` + present would be a mismatch IF this were scanned.
          changes: [{ path: 'src/feature-only.ts', assumption: 'creates' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      },
      {
        type: 'epic',
        slug: 'an-epic',
        title: 'an-epic',
        body: {
          goal: 'g',
          changes: [{ path: 'src/epic-only.ts', assumption: 'creates' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      },
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      // Every probe reports the path present — would trip `creates` if the
      // non-Story tickets were scanned. The empty envelope proves they are
      // partitioned out.
      gitRunner: () => true,
    });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
    assert.deepEqual(report.mismatches, []);
  });

  it('batches multiple mismatches across multiple stories', () => {
    const tickets = [
      makeStory({
        slug: 'story-a',
        body: {
          goal: 'g',
          changes: [{ path: 'src/a.ts', assumption: 'creates' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
      makeStory({
        slug: 'story-b',
        body: {
          goal: 'g',
          changes: [{ path: 'src/b.ts', assumption: 'refactors-existing' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    ];
    // Both probes return the *opposite* of what each story expects.
    const probe = ({ path }) => path === 'src/a.ts'; // a exists (bad for creates), b absent (bad for refactors)
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: probe,
    });
    assert.equal(report.errors.length, 2);
    assert.match(report.errors[0], /"story-a"/);
    assert.match(report.errors[1], /"story-b"/);
  });

  it('emits a deprecation warning for stories with only legacy string bullets', () => {
    const tickets = [
      makeStory({
        body: {
          goal: 'g',
          changes: ['src/x.ts: legacy bullet'],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => true,
    });
    assert.deepEqual(report.errors, []);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /legacy string bullets/);
  });

  it('emits a partial-migration warning when string + object entries mix', () => {
    const tickets = [
      makeStory({
        body: {
          goal: 'g',
          changes: [
            { path: 'src/a.ts', assumption: 'creates' },
            'src/b.ts: legacy',
          ],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => false,
    });
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /mixes object-form/);
  });

  it('throws when baseBranchRef is missing', () => {
    assert.throws(
      () => validateStoryFileAssumptions({ tickets: [] }),
      /baseBranchRef is required/,
    );
  });

  it('caches per-path probe results so siblings reuse the answer', () => {
    let calls = 0;
    const tickets = [
      makeStory({
        slug: 'story-a',
        body: {
          goal: 'g',
          changes: [{ path: 'shared/util.ts', assumption: 'exists' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
      makeStory({
        slug: 'story-b',
        body: {
          goal: 'g',
          changes: [{ path: 'shared/util.ts', assumption: 'exists' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    ];
    validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => {
        calls += 1;
        return true;
      },
    });
    assert.equal(calls, 1);
  });
});

describe('validateStoryFileAssumptions — wave-aware predecessor tree (Story #3960)', () => {
  // Helper: a Story that declares one `{ path, assumption }` change and an
  // optional `depends_on` link list.
  function waveStory({ slug, path, assumption, depends_on = [] }) {
    return {
      type: 'story',
      slug,
      title: slug,
      depends_on,
      body: {
        goal: 'g',
        changes: [{ path, assumption }],
        acceptance: ['ac'],
        verify: ['node --test tests/x.test.js (unit)'],
      },
    };
  }

  // All paths are absent on the base branch unless a test says otherwise —
  // the wave-aware delta is what should drive the verdicts here.
  const absentEverywhere = () => false;

  it('graph shape 1 — dependent `creates` on a predecessor-created path → refactors-existing nudge naming the producer', () => {
    const tickets = [
      waveStory({
        slug: 'producer',
        path: 'src/feed.ts',
        assumption: 'creates',
      }),
      waveStory({
        slug: 'consumer',
        path: 'src/feed.ts',
        assumption: 'creates',
        depends_on: ['producer'],
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: absentEverywhere,
    });
    // Only the dependent Story is flagged; the producer's own `creates`
    // against an absent base path validates clean.
    assert.equal(report.mismatches.length, 1);
    const [m] = report.mismatches;
    assert.equal(m.slug, 'consumer');
    assert.equal(m.assumption, 'creates');
    assert.equal(m.expected, 'refactors-existing');
    assert.equal(m.producerSlug, 'producer');
    assert.match(
      report.errors[0],
      /predecessor Story "producer" already creates/,
    );
    assert.match(report.errors[0], /assumption="refactors-existing" instead/);
  });

  it('graph shape 2 — dependent `refactors-existing` on a path absent from base but created by a predecessor → clean (no false positive)', () => {
    const tickets = [
      waveStory({
        slug: 'data-model',
        path: 'src/route.ts',
        assumption: 'creates',
      }),
      waveStory({
        slug: 'read-path',
        path: 'src/route.ts',
        assumption: 'refactors-existing',
        depends_on: ['data-model'],
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: absentEverywhere,
    });
    // Base-branch-only logic would have flagged read-path's
    // `refactors-existing` as "absent at base"; the predecessor create
    // makes it clean.
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mismatches, []);
  });

  it('graph shape 3 — two concurrent Stories (no depends_on) both `creates` the same path → finding cross-referencing the shared-editor gate', () => {
    const tickets = [
      waveStory({
        slug: 'story-a',
        path: 'src/barrel.ts',
        assumption: 'creates',
      }),
      waveStory({
        slug: 'story-b',
        path: 'src/barrel.ts',
        assumption: 'creates',
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: absentEverywhere,
    });
    // Each Story sees the other as a concurrent co-creator → one
    // predecessor-conflict mismatch per Story (2 total).
    const conflicts = report.mismatches.filter(
      (m) => m.expected === 'predecessor-conflict',
    );
    assert.equal(conflicts.length, 2);
    assert.deepEqual(conflicts.map((m) => m.slug).sort(), [
      'story-a',
      'story-b',
    ]);
    assert.match(report.errors[0], /concurrent Story/);
    assert.match(report.errors[0], /shared-editor conflict finding/);
  });

  it('graph shape 3 — ordered same-path creates do NOT raise a concurrent-conflict (only the predecessor-create nudge fires)', () => {
    const tickets = [
      waveStory({ slug: 'first', path: 'src/x.ts', assumption: 'creates' }),
      waveStory({
        slug: 'second',
        path: 'src/x.ts',
        assumption: 'creates',
        depends_on: ['first'],
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: absentEverywhere,
    });
    // No concurrent-conflict: the two are ordered. The dependent gets the
    // refactors-existing nudge instead.
    assert.equal(
      report.mismatches.filter((m) => m.expected === 'predecessor-conflict')
        .length,
      0,
    );
    assert.equal(
      report.mismatches.filter((m) => m.expected === 'refactors-existing')
        .length,
      1,
    );
  });

  it('graph shape 4 — diamond: two predecessors, one shared created path, dependent refactors it → clean', () => {
    // a → (b, c) both depend on a; d depends on b and c. `a` creates the
    // shared path; `d` refactors it. Transitive reachability puts `a` in
    // `d`'s predecessor set, so the simulated tree has the path present.
    const tickets = [
      waveStory({ slug: 'a', path: 'src/shared.ts', assumption: 'creates' }),
      waveStory({
        slug: 'b',
        path: 'src/b.ts',
        assumption: 'creates',
        depends_on: ['a'],
      }),
      waveStory({
        slug: 'c',
        path: 'src/c.ts',
        assumption: 'creates',
        depends_on: ['a'],
      }),
      waveStory({
        slug: 'd',
        path: 'src/shared.ts',
        assumption: 'refactors-existing',
        depends_on: ['b', 'c'],
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: absentEverywhere,
    });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.mismatches, []);
  });

  it('diamond — dependent `creates` the diamond-shared path → refactors-existing nudge names the transitive producer', () => {
    const tickets = [
      waveStory({ slug: 'a', path: 'src/shared.ts', assumption: 'creates' }),
      waveStory({
        slug: 'b',
        path: 'src/b.ts',
        assumption: 'creates',
        depends_on: ['a'],
      }),
      waveStory({
        slug: 'c',
        path: 'src/c.ts',
        assumption: 'creates',
        depends_on: ['a'],
      }),
      waveStory({
        slug: 'd',
        path: 'src/shared.ts',
        assumption: 'creates',
        depends_on: ['b', 'c'],
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: absentEverywhere,
    });
    const nudges = report.mismatches.filter(
      (m) => m.expected === 'refactors-existing',
    );
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].slug, 'd');
    assert.equal(nudges[0].producerSlug, 'a');
  });

  it('predecessor `deletes` removes a base-present path from the simulated tree → dependent `exists` is flagged absent', () => {
    const tickets = [
      waveStory({ slug: 'remover', path: 'src/old.ts', assumption: 'deletes' }),
      waveStory({
        slug: 'reader',
        path: 'src/old.ts',
        assumption: 'exists',
        depends_on: ['remover'],
      }),
    ];
    // Path is present on the base branch; the predecessor delete removes it.
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => true,
    });
    const readerMismatch = report.mismatches.find((m) => m.slug === 'reader');
    assert.ok(readerMismatch, 'reader should be flagged');
    assert.equal(readerMismatch.expected, 'present');
    assert.equal(readerMismatch.actual, 'absent');
  });

  it('base-branch `creates`-clobber still fires even when a predecessor also creates the path', () => {
    // Path exists on the base branch → the dependent Story would clobber a
    // real file regardless of the predecessor delta. The base-branch
    // mismatch takes precedence over the wave-aware nudge.
    const tickets = [
      waveStory({
        slug: 'producer',
        path: 'src/dup.ts',
        assumption: 'creates',
      }),
      waveStory({
        slug: 'consumer',
        path: 'src/dup.ts',
        assumption: 'creates',
        depends_on: ['producer'],
      }),
    ];
    const report = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => true,
    });
    const consumerMismatch = report.mismatches.find(
      (m) => m.slug === 'consumer',
    );
    assert.equal(consumerMismatch.expected, 'absent');
    assert.equal(consumerMismatch.actual, 'present');
  });
});
