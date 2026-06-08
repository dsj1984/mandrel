import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acceptanceMatrix,
  classifyTest,
  coverageVerdict,
  isSkipped,
  TIERS,
} from '../../../.agents/scripts/lib/qa/coverage-verdict.js';

/**
 * Unit tests for `lib/qa/coverage-verdict.js` — the deterministic per-tier
 * coverage verdict helper backing the `core/qa-coverage-mapping` skill. Pure
 * logic, no I/O, so this is a unit-tier suite per
 * `.agents/rules/testing-standards.md`.
 */

describe('coverageVerdict', () => {
  it('reports a per-tier verdict object keyed by unit, contract, and acceptance', () => {
    // Arrange
    const surface = { symbol: 'parseThing', tests: [] };

    // Act
    const verdict = coverageVerdict(surface);

    // Assert
    assert.deepEqual(Object.keys(verdict).sort(), [
      'acceptance',
      'contract',
      'unit',
    ]);
    for (const tier of TIERS) {
      assert.equal(typeof verdict[tier].status, 'string');
      assert.equal(typeof verdict[tier].note, 'string');
      assert.ok(verdict[tier].note.length > 0);
    }
  });

  it('marks unit present and contract+acceptance absent for a colocated-unit-only surface', () => {
    // Arrange — a finding surface with only a colocated unit test.
    const surface = {
      symbol: 'formatRow',
      tests: ['.agents/scripts/lib/qa/format-row.test.js'],
    };

    // Act
    const verdict = coverageVerdict(surface);

    // Assert
    assert.equal(verdict.unit.status, 'present');
    assert.equal(verdict.contract.status, 'absent');
    assert.equal(verdict.acceptance.status, 'absent');
    // Absent tiers carry an explanatory note referencing the symbol.
    assert.match(verdict.contract.note, /formatRow/);
    assert.match(verdict.acceptance.note, /formatRow/);
  });

  it('marks all tiers present when a test of each kind exercises the surface', () => {
    // Arrange
    const surface = {
      symbol: 'createInvoice',
      tests: [
        'src/invoice.test.ts',
        'tests/contract/invoice.test.ts',
        'tests/features/invoice.feature',
      ],
    };

    // Act
    const verdict = coverageVerdict(surface);

    // Assert
    assert.equal(verdict.unit.status, 'present');
    assert.equal(verdict.contract.status, 'present');
    assert.equal(verdict.acceptance.status, 'present');
  });

  it('classifies a __tests__ directory file as a unit test', () => {
    const verdict = coverageVerdict({
      tests: ['src/__tests__/widget.js'],
    });
    assert.equal(verdict.unit.status, 'present');
  });

  it('honors an explicit tier field over path inference', () => {
    // A .test.js path would normally infer unit; the explicit tier wins.
    const verdict = coverageVerdict({
      tests: [{ path: 'foo.test.js', tier: 'contract' }],
    });
    assert.equal(verdict.contract.status, 'present');
    assert.equal(verdict.unit.status, 'absent');
  });

  it('ignores unclassifiable test entries', () => {
    const verdict = coverageVerdict({
      tests: ['README.md', null, 42, { path: 'notes.txt' }],
    });
    assert.equal(verdict.unit.status, 'absent');
    assert.equal(verdict.contract.status, 'absent');
    assert.equal(verdict.acceptance.status, 'absent');
  });

  it('pluralizes present notes by count', () => {
    const single = coverageVerdict({ tests: ['a.test.js'] });
    assert.match(single.unit.note, /\b1 unit test\b/);

    const plural = coverageVerdict({ tests: ['a.test.js', 'b.test.js'] });
    assert.match(plural.unit.note, /\b2 unit tests\b/);
  });

  it('defaults to all-absent when called with no arguments', () => {
    const verdict = coverageVerdict();
    assert.equal(verdict.unit.status, 'absent');
    assert.equal(verdict.contract.status, 'absent');
    assert.equal(verdict.acceptance.status, 'absent');
  });

  it('throws a TypeError when surface is not an object', () => {
    assert.throws(() => coverageVerdict('nope'), TypeError);
    assert.throws(() => coverageVerdict(null), TypeError);
  });
});

describe('classifyTest', () => {
  it('classifies a .feature file as acceptance', () => {
    assert.equal(classifyTest('tests/features/login.feature'), 'acceptance');
  });

  it('classifies a contract-dir path as contract', () => {
    assert.equal(classifyTest('tests/contract/users.test.ts'), 'contract');
  });

  it('classifies a .contract.test suffix as contract', () => {
    assert.equal(classifyTest('src/users.contract.test.ts'), 'contract');
  });

  it('classifies a colocated .test file as unit', () => {
    assert.equal(classifyTest('src/util.test.js'), 'unit');
  });

  it('normalizes Windows backslash paths', () => {
    assert.equal(classifyTest('tests\\features\\x.feature'), 'acceptance');
  });

  it('returns null for an unclassifiable input', () => {
    assert.equal(classifyTest('docs/readme.md'), null);
    assert.equal(classifyTest(null), null);
    assert.equal(classifyTest({ name: 'no path' }), null);
  });
});

describe('skip / pending awareness', () => {
  it('isSkipped detects a @skip Gherkin tag in a tags array', () => {
    assert.equal(
      isSkipped({ path: 'a.feature', tags: ['@wip', '@skip'] }),
      true,
    );
  });

  it('isSkipped detects a @pending tag in a whitespace string', () => {
    assert.equal(
      isSkipped({ path: 'a.feature', tags: '@smoke @pending' }),
      true,
    );
  });

  it('isSkipped honors explicit skipped / pending boolean flags', () => {
    assert.equal(isSkipped({ path: 'a.test.js', skipped: true }), true);
    assert.equal(isSkipped({ path: 'a.test.js', pending: true }), true);
  });

  it('isSkipped detects runner skip markers in a name', () => {
    assert.equal(
      isSkipped({ path: 'a.test.js', name: 'it.skip should work' }),
      true,
    );
    assert.equal(isSkipped('xit("pending case")'), true);
    assert.equal(isSkipped('describe.skip("group")'), true);
  });

  it('isSkipped is false for a plain, un-skipped test', () => {
    assert.equal(isSkipped('src/util.test.js'), false);
    assert.equal(isSkipped({ path: 'a.feature', tags: ['@smoke'] }), false);
    assert.equal(isSkipped(null), false);
  });

  it('classifyTest returns null for a @skip-tagged feature', () => {
    // Without the tag it would classify as acceptance; the tag makes it inert.
    assert.equal(
      classifyTest({ path: 'tests/features/login.feature', tags: ['@skip'] }),
      null,
    );
  });

  it('counts a @skip-tagged scenario as absent for its tier', () => {
    // Arrange — the only acceptance "coverage" is a skipped scenario.
    const surface = {
      symbol: 'createInvoice',
      tests: [
        'src/invoice.test.js',
        { path: 'tests/features/invoice.feature', tags: ['@skip'] },
      ],
    };

    // Act
    const verdict = coverageVerdict(surface);

    // Assert — unit still present, acceptance falls back to absent.
    assert.equal(verdict.unit.status, 'present');
    assert.equal(verdict.acceptance.status, 'absent');
  });

  it('counts a @pending unit test as absent for the unit tier', () => {
    const verdict = coverageVerdict({
      tests: [{ path: 'a.test.js', tags: '@pending' }],
    });
    assert.equal(verdict.unit.status, 'absent');
  });

  it('counts an explicit skipped: true descriptor as absent', () => {
    const verdict = coverageVerdict({
      tests: [{ path: 'a.test.js', skipped: true }],
    });
    assert.equal(verdict.unit.status, 'absent');
  });
});

describe('acceptanceMatrix', () => {
  it('maps each criterion to its per-tier verdict (array input)', () => {
    // Arrange
    const criteria = [
      {
        id: 'AC-1',
        label: 'parses the row',
        symbol: 'parseRow',
        tests: ['src/parse-row.test.js'],
      },
      {
        id: 'AC-2',
        label: 'renders the report',
        surface: {
          symbol: 'renderReport',
          tests: [
            'src/render.test.js',
            'tests/contract/render.test.js',
            'tests/features/render.feature',
          ],
        },
      },
    ];

    // Act
    const matrix = acceptanceMatrix(criteria);

    // Assert
    assert.deepEqual(matrix.tiers, TIERS);
    assert.equal(matrix.rows.length, 2);
    assert.equal(matrix.rows[0].id, 'AC-1');
    assert.equal(matrix.rows[0].label, 'parses the row');
    assert.equal(matrix.rows[0].verdict.unit.status, 'present');
    assert.equal(matrix.rows[0].verdict.contract.status, 'absent');
    assert.equal(matrix.rows[1].verdict.acceptance.status, 'present');
  });

  it('treats a skipped acceptance test as absent in the matrix', () => {
    const matrix = acceptanceMatrix([
      {
        id: 'AC-1',
        tests: [{ path: 'tests/features/x.feature', tags: ['@skip'] }],
      },
    ]);
    assert.equal(matrix.rows[0].verdict.acceptance.status, 'absent');
  });

  it('accepts an object keyed by criterion id', () => {
    const matrix = acceptanceMatrix({
      'AC-1': { symbol: 'foo', tests: ['src/foo.test.js'] },
    });
    assert.equal(matrix.rows.length, 1);
    assert.equal(matrix.rows[0].id, 'AC-1');
    assert.equal(matrix.rows[0].verdict.unit.status, 'present');
  });

  it('synthesizes an id when a descriptor omits one', () => {
    const matrix = acceptanceMatrix([{ tests: [] }]);
    assert.equal(matrix.rows[0].id, 'AC-1');
    assert.equal(matrix.rows[0].verdict.unit.status, 'absent');
  });

  it('throws a TypeError for a non-array, non-object input', () => {
    assert.throws(() => acceptanceMatrix('nope'), TypeError);
    assert.throws(() => acceptanceMatrix(null), TypeError);
  });
});
