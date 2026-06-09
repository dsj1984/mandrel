/**
 * tests/lib/feedback-loop/audit-results-graduator.test.js — Story #3845
 *
 * Unit tests for the audit-results graduator's pure surface — its
 * `parseFindings` (lens detection plus the 🔵→low / 🟢→suggestion severity
 * mapping that distinguishes it from the code-review parser), the
 * `isAutoFileEnabled` toggle reader, and the `buildIdempotencyMarker`
 * shape. These behaviours diverge from `code-review-graduator.js` and the
 * Story #3845 consolidation MUST preserve them exactly, so they are pinned
 * here at the unit tier alongside the code-review parser unit tests.
 *
 * No real network, git, or filesystem access.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildIdempotencyMarker,
  isAutoFileEnabled,
  parseFindings,
} from '../../../.agents/scripts/lib/feedback-loop/audit-results-graduator.js';

const AUDIT_BODY = [
  '<!-- claude-managed: audit-results -->',
  '#### audit-security',
  '🔴 critical blocker in `src/auth.js` — never graduates',
  '🟠 high finding in `src/api.js`',
  '#### audit-clean-code',
  '🟡 medium finding in `src/util.js`',
  '🟢 suggestion in `src/style.js`',
  '🔵 low finding in `src/perf.js`',
].join('\n');

describe('audit-results parseFindings', () => {
  it('maps 🟢 to suggestion and 🔵 to low (audit-specific divergence)', () => {
    const findings = parseFindings(AUDIT_BODY);
    const bySeverity = Object.fromEntries(
      findings.map((f) => [f.path, f.severity]),
    );
    assert.equal(bySeverity['src/style.js'], 'suggestion');
    assert.equal(bySeverity['src/perf.js'], 'low');
    assert.equal(bySeverity['src/api.js'], 'high');
    assert.equal(bySeverity['src/util.js'], 'medium');
  });

  it('filters out 🔴 critical blockers', () => {
    const findings = parseFindings(AUDIT_BODY);
    assert.ok(
      findings.every((f) => f.path !== 'src/auth.js'),
      'critical blocker must not graduate',
    );
  });

  it('tracks the lens from the most recent #### heading', () => {
    const findings = parseFindings(AUDIT_BODY);
    const lensByPath = Object.fromEntries(
      findings.map((f) => [f.path, f.lens]),
    );
    assert.equal(lensByPath['src/api.js'], 'audit-security');
    assert.equal(lensByPath['src/util.js'], 'audit-clean-code');
    assert.equal(lensByPath['src/style.js'], 'audit-clean-code');
    assert.equal(lensByPath['src/perf.js'], 'audit-clean-code');
  });

  it('assigns zero-based contiguous indices skipping critical lines', () => {
    const findings = parseFindings(AUDIT_BODY);
    assert.deepEqual(
      findings.map((f) => f.index),
      [0, 1, 2, 3],
    );
  });

  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(parseFindings(''), []);
    assert.deepEqual(parseFindings(null), []);
    assert.deepEqual(parseFindings(undefined), []);
  });
});

describe('audit-results isAutoFileEnabled', () => {
  it('defaults to true when config is undefined', () => {
    assert.equal(isAutoFileEnabled(undefined), true);
  });

  it('reads the auditResultsAutoFile toggle, not codeReviewAutoFile', () => {
    assert.equal(
      isAutoFileEnabled({
        delivery: { feedbackLoop: { auditResultsAutoFile: false } },
      }),
      false,
    );
    // The code-review toggle must NOT disable the audit graduator.
    assert.equal(
      isAutoFileEnabled({
        delivery: { feedbackLoop: { codeReviewAutoFile: false } },
      }),
      true,
    );
  });
});

describe('audit-results buildIdempotencyMarker', () => {
  it('produces the audit-results-followup marker shape', () => {
    assert.equal(
      buildIdempotencyMarker(2586, 3),
      '<!-- audit-results-followup: epic-2586-finding-3 -->',
    );
  });
});
