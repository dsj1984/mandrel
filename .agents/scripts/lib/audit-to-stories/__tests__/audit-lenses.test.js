/**
 * Colocated unit tests for the canonical audit lens derivation (Story #4195).
 *
 * Two surfaces:
 *   1. `lensFromSourceReport` / `auditLabelsForFindings` — the basename →
 *      lens mapping that replaces the old junk-dimension derivation.
 *   2. `buildStoryBody().labels` — the integration assertion the acceptance
 *      calls for: a multi-dimension group yields ONLY canonical
 *      `audit::<lens>` labels, derived from each finding's `sourceReport`,
 *      never from the fine-grained dimension text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIT_LENSES,
  auditLabelsForFindings,
  isCanonicalLens,
  lensFromSourceReport,
} from '../audit-lenses.js';
import { buildStoryBody } from '../build-story-body.js';

describe('lensFromSourceReport', () => {
  it('derives the canonical lens from an audit-<lens>-results.md basename', () => {
    assert.equal(
      lensFromSourceReport('temp/audits/audit-clean-code-results.md'),
      'clean-code',
    );
    assert.equal(
      lensFromSourceReport('temp/audits/audit-security-results.md'),
      'security',
    );
  });

  it('is basename-only — ignores the directory portion', () => {
    assert.equal(
      lensFromSourceReport('/abs/anywhere/deep/audit-performance-results.md'),
      'performance',
    );
  });

  it('handles Windows backslash separators', () => {
    assert.equal(
      lensFromSourceReport('temp\\audits\\audit-architecture-results.md'),
      'architecture',
    );
  });

  it('returns null for a non-canonical lens token (the junk-label guard)', () => {
    // `stale-description` is a dimension, not a lens — it must never mint a label.
    assert.equal(
      lensFromSourceReport('temp/audits/audit-stale-description-results.md'),
      null,
    );
  });

  it('returns null for a path that does not match the report shape', () => {
    assert.equal(lensFromSourceReport('temp/audits/notes.md'), null);
    assert.equal(lensFromSourceReport('audit-security.md'), null);
    assert.equal(lensFromSourceReport(''), null);
    assert.equal(lensFromSourceReport(null), null);
    assert.equal(lensFromSourceReport(undefined), null);
  });
});

describe('isCanonicalLens', () => {
  it('accepts every canonical lens and rejects dimension prose', () => {
    for (const lens of AUDIT_LENSES) {
      assert.ok(isCanonicalLens(lens), `expected ${lens} to be canonical`);
    }
    assert.ok(!isCanonicalLens('maintainability'));
    assert.ok(!isCanonicalLens('injection'));
    assert.ok(!isCanonicalLens('efficiency-(cpu)'));
  });
});

describe('auditLabelsForFindings', () => {
  it('emits one canonical label per distinct source report, sorted & deduped', () => {
    const findings = [
      { sourceReport: 'temp/audits/audit-security-results.md' },
      { sourceReport: 'temp/audits/audit-security-results.md' },
      { sourceReport: 'temp/audits/audit-clean-code-results.md' },
    ];
    assert.deepEqual(auditLabelsForFindings(findings), [
      'audit::clean-code',
      'audit::security',
    ]);
  });

  it('drops findings whose sourceReport does not resolve to a canonical lens', () => {
    const findings = [
      { sourceReport: 'temp/audits/audit-stale-description-results.md' },
      { sourceReport: 'temp/audits/audit-quality-results.md' },
      { sourceReport: undefined },
    ];
    assert.deepEqual(auditLabelsForFindings(findings), ['audit::quality']);
  });

  it('returns an empty array for empty / nullish input', () => {
    assert.deepEqual(auditLabelsForFindings([]), []);
    assert.deepEqual(auditLabelsForFindings(undefined), []);
  });
});

describe('buildStoryBody label derivation (acceptance: multi-dimension group)', () => {
  // A synthetic cross-audit group: three findings whose *dimensions* are
  // free-form prose that would have minted junk labels under the old
  // `audit::<dimension>` derivation, sourced from two distinct lens reports.
  const multiDimensionGroup = {
    title: 'Harden src/auth/session.js',
    dimensions: ['injection', 'maintainability', 'efficiency (cpu)'],
    files: ['src/auth/session.js'],
    severity: 'high',
    findings: [
      {
        title: 'SQLi in session lookup',
        severity: 'high',
        dimension: 'injection',
        currentState: 'string-concatenated query',
        recommendation: 'parameterise the query',
        sourceReport: 'temp/audits/audit-security-results.md',
        fingerprint: { full: 'a'.repeat(40), short: 'a'.repeat(12) },
      },
      {
        title: 'God function in session.js',
        severity: 'medium',
        dimension: 'maintainability',
        currentState: '300-line handler',
        recommendation: 'extract helpers',
        sourceReport: 'temp/audits/audit-clean-code-results.md',
        fingerprint: { full: 'b'.repeat(40), short: 'b'.repeat(12) },
      },
      {
        title: 'O(n^2) scan on hot path',
        severity: 'high',
        dimension: 'efficiency (cpu)',
        currentState: 'nested loop over sessions',
        recommendation: 'index by id',
        sourceReport: 'temp/audits/audit-performance-results.md',
        fingerprint: { full: 'c'.repeat(40), short: 'c'.repeat(12) },
      },
    ],
  };

  it('produces only canonical audit::<lens> labels (one per distinct report)', () => {
    const { labels } = buildStoryBody({ group: multiDimensionGroup });
    const auditLabels = labels.filter((l) => l.startsWith('audit::'));
    assert.deepEqual(auditLabels.sort(), [
      'audit::clean-code',
      'audit::performance',
      'audit::security',
    ]);
  });

  it('never emits a dimension-derived junk label', () => {
    const { labels } = buildStoryBody({ group: multiDimensionGroup });
    for (const junk of [
      'audit::injection',
      'audit::maintainability',
      'audit::efficiency-(cpu)',
      'audit::efficiency',
    ]) {
      assert.ok(!labels.includes(junk), `must not emit ${junk}`);
    }
  });

  it('every emitted audit label is in the canonical lens set', () => {
    const { labels } = buildStoryBody({ group: multiDimensionGroup });
    for (const label of labels.filter((l) => l.startsWith('audit::'))) {
      const lens = label.slice('audit::'.length);
      assert.ok(isCanonicalLens(lens), `${label} is not a canonical lens`);
    }
  });

  it('still carries the static type::story / agent::ready labels', () => {
    const { labels } = buildStoryBody({ group: multiDimensionGroup });
    assert.ok(labels.includes('type::story'));
    assert.ok(labels.includes('agent::ready'));
  });
});
