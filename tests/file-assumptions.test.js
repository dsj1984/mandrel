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
