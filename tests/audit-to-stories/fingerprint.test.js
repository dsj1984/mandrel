import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseAuditReport } from '../../.agents/scripts/lib/audit-to-stories/parse-audit-md.js';
import {
  fingerprintFinding,
  withFingerprints,
  renderFingerprintFooter,
  parseFingerprintFooter,
} from '../../.agents/scripts/lib/audit-to-stories/fingerprint.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, 'fixtures');

function loadReport(name) {
  return parseAuditReport({
    markdown: fs.readFileSync(path.join(FIXTURES, name), 'utf8'),
    sourceReport: path.join(FIXTURES, name),
  });
}

test('fingerprintFinding produces a stable sha1 for identical inputs', () => {
  const a = {
    dimension: 'injection',
    normalisedTitle: 'unparameterised sql query in login handler',
    files: ['src/routes/auth/login.js'],
  };
  const b = { ...a };
  const fpA = fingerprintFinding(a);
  const fpB = fingerprintFinding(b);
  assert.equal(fpA.full, fpB.full);
  assert.equal(fpA.short.length, 12);
  assert.equal(fpA.full.length, 40);
});

test('fingerprintFinding differs when title differs', () => {
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
  assert.notEqual(fingerprintFinding(a).full, fingerprintFinding(b).full);
});

test('fingerprintFinding differs when primary file differs', () => {
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
  assert.notEqual(fingerprintFinding(a).full, fingerprintFinding(b).full);
});

test('fingerprintFinding tolerates a finding with no files', () => {
  const fp = fingerprintFinding({
    dimension: 'privacy',
    normalisedTitle: 'no concrete file referenced',
    files: [],
  });
  assert.equal(fp.full.length, 40);
  assert.equal(fp.components.primaryFile, '');
});

test('parser → fingerprint round-trip is stable across reparses (Story AC #3)', () => {
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
  assert.deepEqual(parsed, findings.map((f) => f.fingerprint.full));
});

test('parseFingerprintFooter returns empty array when marker absent', () => {
  assert.deepEqual(parseFingerprintFooter('hello world'), []);
});

test('parseFingerprintFooter ignores malformed sha entries', () => {
  const body = '<!-- audit-fingerprints: notasha, abc, 0123456789abcdef0123456789abcdef01234567 -->';
  assert.deepEqual(parseFingerprintFooter(body), [
    '0123456789abcdef0123456789abcdef01234567',
  ]);
});

test('withFingerprints throws on non-array input', () => {
  assert.throws(() => withFingerprints(null));
});
