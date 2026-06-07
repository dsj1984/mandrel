import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { coverageVerdict } from '../../../.agents/scripts/lib/qa/coverage-verdict.js';
import { proposeMissingTest } from '../../../.agents/scripts/lib/qa/propose-missing-test.js';

/**
 * Unit tests for `lib/qa/propose-missing-test.js` — the deterministic
 * missing-test proposal helper backing the `core/qa-coverage-mapping` skill.
 * Pure logic, no I/O, so this is a unit-tier suite per
 * `.agents/rules/testing-standards.md`.
 */

describe('proposeMissingTest', () => {
  it('proposes the lowest absent tier (unit) when all tiers are absent', () => {
    // Arrange — a surface with no tests at all: every tier is absent.
    const verdict = coverageVerdict({ symbol: 'parseThing', tests: [] });

    // Act
    const proposal = proposeMissingTest(verdict);

    // Assert — unit is the cheapest (lowest) absent tier.
    assert.ok(proposal, 'expected a proposal');
    assert.equal(proposal.tier, 'unit');
    assert.equal(typeof proposal.description, 'string');
    assert.ok(proposal.description.length > 0);
  });

  it('proposes contract when unit is present but contract+acceptance are absent', () => {
    // Arrange — only a colocated unit test exercises the surface.
    const verdict = coverageVerdict({
      symbol: 'formatRow',
      tests: ['.agents/scripts/lib/qa/format-row.test.js'],
    });

    // Act
    const proposal = proposeMissingTest(verdict);

    // Assert — unit is covered, so the lowest remaining gap is contract.
    assert.ok(proposal, 'expected a proposal');
    assert.equal(proposal.tier, 'contract');
  });

  it('proposes acceptance when only acceptance is absent', () => {
    // Arrange — unit + contract present, acceptance missing.
    const verdict = coverageVerdict({
      symbol: 'createInvoice',
      tests: [
        '.agents/scripts/lib/qa/create-invoice.test.js',
        'tests/contract/create-invoice.test.js',
      ],
    });

    // Act
    const proposal = proposeMissingTest(verdict);

    // Assert
    assert.ok(proposal, 'expected a proposal');
    assert.equal(proposal.tier, 'acceptance');
  });

  it('returns null when every tier is present (full coverage)', () => {
    // Arrange — a test of each kind exercises the surface.
    const verdict = coverageVerdict({
      symbol: 'createInvoice',
      tests: [
        '.agents/scripts/lib/qa/create-invoice.test.js',
        'tests/contract/create-invoice.test.js',
        'tests/features/create-invoice.feature',
      ],
    });

    // Act
    const proposal = proposeMissingTest(verdict);

    // Assert — no gap, no proposal.
    assert.equal(proposal, null);
  });

  it('includes the target tier and a one-line description string in the proposal', () => {
    // Arrange
    const verdict = coverageVerdict({ symbol: 'parseThing', tests: [] });

    // Act
    const proposal = proposeMissingTest(verdict);

    // Assert — shape contract: { tier, description }.
    assert.deepEqual(Object.keys(proposal).sort(), ['description', 'tier']);
    assert.ok(['unit', 'contract', 'acceptance'].includes(proposal.tier));
    // One line — no embedded newline.
    assert.ok(!proposal.description.includes('\n'));
    // The description carries the verdict's explanatory note forward.
    assert.match(proposal.description, /parseThing/);
  });

  it('skips a present lower tier and proposes the next absent one in pyramid order', () => {
    // Arrange — explicit tiers: unit present, contract absent, acceptance
    // present. The lowest *absent* tier is contract, even though a higher
    // tier (acceptance) is covered.
    const verdict = coverageVerdict({
      symbol: 'syncLedger',
      tests: [{ tier: 'unit' }, { tier: 'acceptance' }],
    });

    // Act
    const proposal = proposeMissingTest(verdict);

    // Assert
    assert.equal(proposal.tier, 'contract');
  });

  it('throws a TypeError when handed a non-object verdict', () => {
    // Arrange / Act / Assert
    assert.throws(() => proposeMissingTest(null), TypeError);
    assert.throws(() => proposeMissingTest('verdict'), TypeError);
  });
});
