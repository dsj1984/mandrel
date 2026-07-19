/**
 * AC-5 (Story #4626): close-time and sweep-time filings share one identity.
 *
 * The close-time `audit-results-graduator` now stamps the canonical
 * `audit-fingerprints` footer (computed off the shared route-finding
 * canonical hash) into every follow-up it files — not only its own
 * content-hash `audit-results-followup` marker. So the sweep-time
 * `/audit-to-stories` dedup probe recognizes a graduator-filed Issue and never
 * re-files it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalFingerprintFooter,
  toCanonicalFinding as graduatorCanonical,
} from '../../.agents/scripts/lib/feedback-loop/audit-results-graduator.js';
import {
  parseFingerprintFooter,
  routeFinding,
} from '../../.agents/scripts/lib/findings/route-finding.js';

// The graduator finding shape: { severity, lens, path, summary }.
const gradFinding = {
  severity: 'medium',
  lens: 'audit-security',
  path: '.agents/scripts/lib/dispatch/plan.js',
  summary: '🟡 Unbounded recursion in dispatch planner',
};

test('the graduator stamps a parseable canonical audit-fingerprints footer', () => {
  const footer = canonicalFingerprintFooter(gradFinding);
  const shas = parseFingerprintFooter(footer);
  assert.equal(shas.length, 1);
  assert.match(shas[0], /^[0-9a-f]{40}$/);
});

test('AC-5: the dedup probe recognizes a graduator-filed issue via the shared footer', async () => {
  // The follow-up body the graduator would file, carrying the canonical footer.
  const filedBody = [
    '<!-- audit-results-followup: epic-42-abc123 -->',
    'Auto-filed follow-up body.',
    canonicalFingerprintFooter(gradFinding),
  ].join('\n\n');

  // A sweep re-detects the SAME finding and routes it through the shared
  // helper with a fingerprint search that returns the graduator-filed issue.
  const store = [{ number: 900, state: 'open', body: filedBody }];
  const result = await routeFinding(graduatorCanonical(gradFinding), {
    searchIssues: async () => store,
  });

  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 900);
});

test('AC-5: a graduator-filed issue closed as completed routes to regression-of-closed', async () => {
  const filedBody = canonicalFingerprintFooter(gradFinding);
  const result = await routeFinding(graduatorCanonical(gradFinding), {
    searchIssues: async () => [
      { number: 901, state: 'closed', body: filedBody },
    ],
  });
  assert.equal(result.decision, 'regression-of-closed');
});
