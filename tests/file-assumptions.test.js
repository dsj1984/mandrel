import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectTaskAssumptionEntries,
  FILE_ASSUMPTION_VALUES,
  hasLegacyChangeBullets,
  validateTaskFileAssumptions,
} from '../.agents/scripts/lib/orchestration/file-assumptions.js';
import {
  isMalformedObjectPathEntry,
  isObjectPathEntry,
  validateTaskBodyShape,
} from '../.agents/scripts/lib/orchestration/task-body-validator.js';

/**
 * Story #2636 — Phase 8 path-assumption gate.
 *
 * The validator inspects each Task's body.changes and body.references
 * for object-form `{ path, assumption }` entries and verifies them
 * against `baseBranchRef`. Legacy string-form bullets are tolerated and
 * emit a one-time deprecation warning per Task.
 */

function makeTask({ slug = 'demo-task', body }) {
  return { type: 'task', slug, title: slug, body };
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
      makeTask({
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
      makeTask({
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
      makeTask({
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
      makeTask({
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

describe('collectTaskAssumptionEntries — extraction helper', () => {
  it('walks changes and references and tags each entry with its source', () => {
    const entries = collectTaskAssumptionEntries(
      makeTask({
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
    const entries = collectTaskAssumptionEntries(
      makeTask({
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
    const task = makeTask({
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
    assert.equal(hasLegacyChangeBullets(task), true);
  });

  it('returns false when every change is object-form', () => {
    const task = makeTask({
      body: {
        goal: 'g',
        changes: [{ path: 'src/a.ts', assumption: 'creates' }],
        acceptance: ['ac'],
        verify: ['v'],
      },
    });
    assert.equal(hasLegacyChangeBullets(task), false);
  });
});

describe('validateTaskFileAssumptions — rules table', () => {
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
        makeTask({
          body: {
            goal: 'g',
            changes: [{ path: 'src/sample.ts', assumption: tc.assumption }],
            acceptance: ['ac'],
            verify: ['node --test tests/x.test.js (unit)'],
          },
        }),
      ];
      const report = validateTaskFileAssumptions({
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

  it('batches multiple mismatches across multiple tasks', () => {
    const tickets = [
      makeTask({
        slug: 'task-a',
        body: {
          goal: 'g',
          changes: [{ path: 'src/a.ts', assumption: 'creates' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
      makeTask({
        slug: 'task-b',
        body: {
          goal: 'g',
          changes: [{ path: 'src/b.ts', assumption: 'refactors-existing' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    ];
    // Both probes return the *opposite* of what each task expects.
    const probe = ({ path }) => path === 'src/a.ts'; // a exists (bad for creates), b absent (bad for refactors)
    const report = validateTaskFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: probe,
    });
    assert.equal(report.errors.length, 2);
    assert.match(report.errors[0], /"task-a"/);
    assert.match(report.errors[1], /"task-b"/);
  });

  it('emits a deprecation warning for tasks with only legacy string bullets', () => {
    const tickets = [
      makeTask({
        body: {
          goal: 'g',
          changes: ['src/x.ts: legacy bullet'],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    ];
    const report = validateTaskFileAssumptions({
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
      makeTask({
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
    const report = validateTaskFileAssumptions({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => false,
    });
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /mixes object-form/);
  });

  it('throws when baseBranchRef is missing', () => {
    assert.throws(
      () => validateTaskFileAssumptions({ tickets: [] }),
      /baseBranchRef is required/,
    );
  });

  it('caches per-path probe results so siblings reuse the answer', () => {
    let calls = 0;
    const tickets = [
      makeTask({
        slug: 'task-a',
        body: {
          goal: 'g',
          changes: [{ path: 'shared/util.ts', assumption: 'exists' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
      makeTask({
        slug: 'task-b',
        body: {
          goal: 'g',
          changes: [{ path: 'shared/util.ts', assumption: 'exists' }],
          acceptance: ['ac'],
          verify: ['node --test tests/x.test.js (unit)'],
        },
      }),
    ];
    validateTaskFileAssumptions({
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
