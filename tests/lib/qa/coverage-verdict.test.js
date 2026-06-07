import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyTest,
  coverageVerdict,
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
