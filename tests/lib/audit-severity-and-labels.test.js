/**
 * Story #4877 — one severity vocabulary and only real labels, end to end
 * through the audit finding pipeline.
 *
 * Two defects are covered here, both of which were invisible in normal use:
 *
 *  1. **A finding dropped by every severity-filtered run.** Four modules each
 *     carried a partial copy of the severity vocabulary and none of them knew
 *     `info` — the canonical floor. A lens grading a finding `Info` /
 *     `Informational` produced a finding that parsed to no severity, tallied as
 *     `unknown`, and failed every threshold including the most permissive. It
 *     did not error; it silently did not exist.
 *  2. **A generated label the repository does not have.** The audit filer
 *     emitted `risk::high` as a bare string literal, defined by no taxonomy at
 *     all — the shape that made every `gh issue create` in the feedback loop
 *     fail in Story #4828.
 *
 * These are pipeline tests: they drive the real parser, the real severity
 * filter, and the real label generator rather than asserting on the constants.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing as auditToStoriesTesting } from '../../.agents/scripts/audit-to-stories.js';
import {
  AUDIT_LABEL_TAXONOMY,
  definesAuditLabel,
} from '../../.agents/scripts/lib/audit-to-stories/audit-label-taxonomy.js';
import { buildStoryBody } from '../../.agents/scripts/lib/audit-to-stories/build-story-body.js';
import { parseAuditReports } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import {
  SEVERITIES,
  SEVERITY_RANK,
} from '../../.agents/scripts/lib/findings/severity.js';

const { meetsSeverity } = auditToStoriesTesting;

/**
 * Render an `audit-<lens>-results.md` report carrying one finding, in the shape
 * the architecture lens actually writes it: the severity axis relabelled
 * `Impact`, per that lens's preamble.
 */
function architectureReport(impact) {
  return {
    sourceReport: 'temp/audits/audit-architecture-results.md',
    markdown: [
      '# Architecture & Clean Code Review',
      '',
      '## Executive Summary',
      '',
      'Self-cross-check: kept 1 / dropped 0.',
      '',
      '## Detailed Findings',
      '',
      '### `lib/seam.js` — Writer with no reader',
      '',
      '- **Dimension:** Shipped-But-Never-Wired Seams',
      `- **Impact:** ${impact}`,
      '- **Location:** `lib/seam.js:12`',
      '- **Current State:** the envelope field is stamped and never read.',
      '- **Recommendation & Rationale:** build the reader or drop the field.',
      '- **Acceptance signal:** a test that fails when the caller is removed.',
      '',
    ].join('\n'),
  };
}

function parseOne(impact) {
  const findings = parseAuditReports([architectureReport(impact)], {
    repoRoot: process.cwd(),
  });
  assert.equal(findings.length, 1, 'fixture must yield exactly one finding');
  return findings[0];
}

describe('one severity vocabulary (Story #4877, AC-1 / AC-2)', () => {
  it('every canonical level is rankable by the severity filter', () => {
    // The local rank table this replaces omitted `info`, so the canonical floor
    // ranked below even `--severity low`. A level that exists in the vocabulary
    // but is invisible to the filter is the bug.
    for (const level of SEVERITIES) {
      assert.equal(
        typeof SEVERITY_RANK[level],
        'number',
        `${level} must be rankable`,
      );
    }
  });

  it('an architecture-lens finding graded Info parses as info, not unknown (AC-2)', () => {
    assert.equal(parseOne('Info').severity, 'info');
    assert.equal(parseOne('Informational').severity, 'info');
  });

  it('an Info architecture finding survives a severity-filtered run (AC-2)', () => {
    const finding = parseOne('Informational');
    for (const threshold of [undefined, 'all', 'info']) {
      assert.equal(
        meetsSeverity(finding, threshold),
        true,
        `an info finding must survive the ${threshold ?? 'unset'} threshold`,
      );
    }
  });

  it('an Info finding is still correctly excluded by a higher floor', () => {
    // Rescuing `info` from oblivion must not promote it above its rank.
    const finding = parseOne('Informational');
    for (const threshold of ['low', 'medium', 'high', 'critical']) {
      assert.equal(
        meetsSeverity(finding, threshold),
        false,
        `an info finding must not clear the ${threshold} floor`,
      );
    }
  });

  it('every canonical level clears its own floor and fails the one above it', () => {
    for (const [index, level] of SEVERITIES.entries()) {
      assert.equal(
        meetsSeverity({ severity: level }, level),
        true,
        `${level} must clear its own floor`,
      );
      const higher = SEVERITIES[index - 1];
      if (higher) {
        assert.equal(
          meetsSeverity({ severity: level }, higher),
          false,
          `${level} must not clear the ${higher} floor`,
        );
      }
    }
  });

  it('a finding whose severity did not parse never clears a real floor', () => {
    // An unparseable severity is not evidence that a threshold was met.
    for (const severity of [null, undefined, 'spicy']) {
      assert.equal(meetsSeverity({ severity }, 'info'), false);
      assert.equal(meetsSeverity({ severity }, 'critical'), false);
    }
  });

  it('the alias spellings a lens might write all reach a canonical level', () => {
    const expected = {
      Critical: 'critical',
      Blocker: 'critical',
      High: 'high',
      Major: 'high',
      Medium: 'medium',
      Moderate: 'medium',
      Low: 'low',
      Minor: 'low',
      Info: 'info',
      Informational: 'info',
    };
    for (const [written, canonical] of Object.entries(expected)) {
      assert.equal(
        parseOne(written).severity,
        canonical,
        `a lens writing "${written}" must reach ${canonical}`,
      );
    }
  });
});

describe('generated labels name only defined categories (Story #4877, AC-3)', () => {
  /** A group in the shape `groupFindings` emits, with one finding. */
  function group({ severity = 'medium' } = {}) {
    return {
      groupKey: 'g1',
      title: 'Remediate the unwired seam',
      dimensions: ['architecture'],
      files: ['lib/seam.js'],
      findings: [
        {
          title: 'Writer with no reader',
          severity,
          dimension: 'Shipped-But-Never-Wired Seams',
          files: ['lib/seam.js'],
          sourceReport: 'temp/audits/audit-architecture-results.md',
          recommendation: 'Build the reader.',
        },
      ],
    };
  }

  it('the taxonomy defines every label the filer generates', () => {
    for (const severity of ['medium', 'critical']) {
      const { labels } = buildStoryBody({ group: group({ severity }) });
      for (const label of labels) {
        assert.equal(
          definesAuditLabel(label),
          true,
          `generated label "${label}" is not defined by the audit label taxonomy`,
        );
      }
    }
  });

  it('risk::high is generated for a Critical finding AND defined by the taxonomy', () => {
    // It was generated but defined nowhere — neither LABEL_TAXONOMY nor the
    // audit bootstrap created it — so the filer emitted a label the repo lacked.
    const { labels } = buildStoryBody({
      group: group({ severity: 'critical' }),
    });
    assert.ok(
      labels.includes('risk::high'),
      'a Critical finding must mark risk',
    );
    assert.equal(definesAuditLabel('risk::high'), true);
    assert.ok(
      AUDIT_LABEL_TAXONOMY.some((l) => l.name === 'risk::high'),
      'the bootstrap must actually create risk::high, not merely tolerate it',
    );
  });

  it('a non-Critical group does not carry risk::high', () => {
    const { labels } = buildStoryBody({ group: group({ severity: 'medium' }) });
    assert.ok(!labels.includes('risk::high'));
  });

  it('every taxonomy entry is creatable by `gh label create`', () => {
    for (const entry of AUDIT_LABEL_TAXONOMY) {
      assert.match(
        entry.name,
        /^[a-z]+::[a-z0-9-]+$/,
        `"${entry.name}" is not a well-formed axis::value label`,
      );
      assert.match(
        entry.color,
        /^[0-9a-fA-F]{6}$/,
        `"${entry.name}" colour must be a bare hex triplet, not a CSS #rrggbb — ` +
          '`gh label create --color` rejects the hash',
      );
      assert.ok(
        typeof entry.description === 'string' && entry.description.length > 0,
        `"${entry.name}" needs a description`,
      );
    }
  });

  it('the taxonomy has no duplicate label names', () => {
    const names = AUDIT_LABEL_TAXONOMY.map((l) => l.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('definesAuditLabel rejects an undefined label and a non-string', () => {
    assert.equal(definesAuditLabel('audit::not-a-lens'), false);
    assert.equal(definesAuditLabel('risk::medium'), false);
    assert.equal(definesAuditLabel(undefined), false);
    assert.equal(definesAuditLabel(42), false);
  });
});
