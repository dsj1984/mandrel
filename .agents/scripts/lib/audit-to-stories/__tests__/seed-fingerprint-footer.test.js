/**
 * AC-3 (Story #4626): the recommended `/plan --seed-file` path keeps dedup.
 *
 * The plan seed emitted by `buildPlanSeedMarkdown` MUST carry each finding
 * group's `audit-fingerprints` footer so a Story authored from the seed
 * inherits the dedup identity and the next sweep recognizes it. Historically
 * the seed dropped the footer, permanently breaking dedup on the recommended
 * path.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFingerprintFooter } from '../../findings/route-finding.js';
import { withFingerprints } from '../finding-adapter.js';
import { groupFindings } from '../group-findings.js';
import { buildPlanSeedMarkdown } from '../seed-from-findings.js';

function auditFinding(dimension, title, file) {
  return {
    dimension,
    severity: 'high',
    title,
    normalisedTitle: title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim(),
    files: file ? [file] : [],
    currentState: '',
    recommendation: `Fix ${title}`,
  };
}

test('the plan seed carries every finding group audit-fingerprints footer', () => {
  const stamped = withFingerprints([
    auditFinding('security', 'SQLi in login', 'src/auth/login.js'),
    auditFinding('perf', 'N+1 in invoice list', 'src/invoices/list.js'),
  ]);
  const { groups } = groupFindings(stamped);
  assert.ok(groups.length >= 2, 'distinct files produce distinct groups');

  const seed = buildPlanSeedMarkdown({
    groups,
    findings: stamped,
    sourceReports: ['temp/audits/audit-security-results.md'],
  });

  // Collect the shas from EVERY per-group footer the seed renders (there is
  // one audit-fingerprints footer per group, so a single parse would only see
  // the first).
  const footerShas = new Set();
  for (const m of seed.matchAll(/<!--\s*audit-fingerprints:[^>]*-->/g)) {
    for (const sha of parseFingerprintFooter(m[0])) footerShas.add(sha);
  }
  for (const f of stamped) {
    assert.ok(
      footerShas.has(f.fingerprint.full),
      `seed footer must carry ${f.fingerprint.short}`,
    );
  }

  // One machine-readable footer per group (2 distinct-file groups here).
  const footerCount = [...seed.matchAll(/<!--\s*audit-fingerprints:/g)].length;
  assert.equal(footerCount, groups.length);
});

test('the seed still renders the human one-pager sections', () => {
  const stamped = withFingerprints([
    auditFinding('security', 'SQLi in login', 'src/auth/login.js'),
  ]);
  const { groups } = groupFindings(stamped);
  const seed = buildPlanSeedMarkdown({
    groups,
    findings: stamped,
    sourceReports: ['temp/audits/audit-security-results.md'],
  });
  assert.match(seed, /## Problem Statement/);
  assert.match(seed, /## MVP Scope/);
});
