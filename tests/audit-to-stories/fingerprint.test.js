/**
 * Audit-side fingerprint adapter tests.
 *
 * The raw fingerprint/footer primitives now live in the shared
 * `lib/findings/route-finding.js` helper (covered by
 * `tests/lib/findings/route-finding{,.contract}.test.js`). These tests cover
 * the audit-specific adapter (`lib/audit-to-stories/finding-adapter.js`) that
 * projects parsed audit findings onto the shared identity — the parser →
 * adapter round-trip stability and the multi-sha footer round-trip.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import url from 'node:url';
import {
  fingerprintAuditFinding,
  renderFingerprintFooter,
  withFingerprints,
} from '../../.agents/scripts/lib/audit-to-stories/finding-adapter.js';
import { parseAuditReport } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import { parseFingerprintFooter } from '../../.agents/scripts/lib/findings/route-finding.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, 'fixtures');

function loadReport(name) {
  return parseAuditReport({
    markdown: fs.readFileSync(path.join(FIXTURES, name), 'utf8'),
    sourceReport: path.join(FIXTURES, name),
  });
}

test('fingerprintAuditFinding produces a stable sha1 for identical inputs', () => {
  const a = {
    dimension: 'injection',
    normalisedTitle: 'unparameterised sql query in login handler',
    files: ['src/routes/auth/login.js'],
  };
  const b = { ...a };
  const fpA = fingerprintAuditFinding(a);
  const fpB = fingerprintAuditFinding(b);
  assert.equal(fpA.full, fpB.full);
  assert.equal(fpA.short.length, 12);
  assert.equal(fpA.full.length, 40);
});

test('fingerprintAuditFinding differs when title differs', () => {
  const a = {
    dimension: 'injection',
    normalisedTitle: 'sql injection in login',
    files: ['src/x.js'],
  };
  const b = {
    dimension: 'injection',
    normalisedTitle: 'sql injection in signup',
    files: ['src/x.js'],
  };
  assert.notEqual(
    fingerprintAuditFinding(a).full,
    fingerprintAuditFinding(b).full,
  );
});

test('fingerprintAuditFinding differs when primary file differs', () => {
  const a = {
    dimension: 'injection',
    normalisedTitle: 'sqli',
    files: ['src/a.js'],
  };
  const b = {
    dimension: 'injection',
    normalisedTitle: 'sqli',
    files: ['src/b.js'],
  };
  assert.notEqual(
    fingerprintAuditFinding(a).full,
    fingerprintAuditFinding(b).full,
  );
});

test('fingerprintAuditFinding tolerates a finding with no files', () => {
  const fp = fingerprintAuditFinding({
    dimension: 'privacy',
    normalisedTitle: 'no concrete file referenced',
    files: [],
  });
  assert.equal(fp.full.length, 40);
  assert.equal(fp.components.primaryFile, '');
});

test('parser → adapter fingerprint round-trip is stable across reparses', () => {
  const first = withFingerprints(loadReport('audit-security-results.md'));
  const second = withFingerprints(loadReport('audit-security-results.md'));
  const firstShas = first.map((f) => f.fingerprint.full);
  const secondShas = second.map((f) => f.fingerprint.full);
  assert.deepEqual(firstShas, secondShas);
});

test('renderFingerprintFooter / parseFingerprintFooter round-trip', () => {
  const findings = withFingerprints(loadReport('audit-security-results.md'));
  const body = `Some issue body.\n\n${renderFingerprintFooter(findings)}\n`;
  const parsed = parseFingerprintFooter(body);
  assert.deepEqual(
    parsed,
    findings.map((f) => f.fingerprint.full),
  );
});

test('renderFingerprintFooter emits a single comma-joined marker', () => {
  const findings = withFingerprints(loadReport('audit-security-results.md'));
  const footer = renderFingerprintFooter(findings);
  const markerCount = (footer.match(/audit-fingerprints:/g) ?? []).length;
  assert.equal(markerCount, 1);
});

test('withFingerprints throws on non-array input', () => {
  assert.throws(() => withFingerprints(null));
});
