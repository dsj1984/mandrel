import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fingerprintFinding,
  fingerprintFooter,
  parseFingerprintFooter,
  routeFinding,
} from '../../../.agents/scripts/lib/findings/route-finding.js';

const baseFinding = {
  title: 'Unparameterised SQL query in login handler',
  area: 'injection',
  primaryFile: 'src/routes/auth/login.js',
  severity: 'high',
  labels: ['security', 'sql'],
};

test('fingerprintFinding produces a stable sha1 for identical inputs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding });
  assert.equal(a.full, b.full);
  assert.equal(a.full.length, 40);
  assert.equal(a.short.length, 12);
  assert.equal(a.short, a.full.slice(0, 12));
});

test('fingerprintFinding is order-independent in labels', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, labels: ['sql', 'security'] });
  assert.equal(a.full, b.full);
});

test('fingerprintFinding is case- and whitespace-insensitive', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({
    ...baseFinding,
    title: '  UNPARAMETERISED SQL QUERY IN LOGIN HANDLER  ',
    severity: 'High',
  });
  assert.equal(a.full, b.full);
});

test('fingerprintFinding differs when title differs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, title: 'SQLi in signup' });
  assert.notEqual(a.full, b.full);
});

test('fingerprintFinding differs when severity differs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, severity: 'low' });
  assert.notEqual(a.full, b.full);
});

test('fingerprintFinding differs when primaryFile differs', () => {
  const a = fingerprintFinding(baseFinding);
  const b = fingerprintFinding({ ...baseFinding, primaryFile: 'src/x.js' });
  assert.notEqual(a.full, b.full);
});

test('fingerprintFinding tolerates missing fields', () => {
  const fp = fingerprintFinding({ title: 'only a title' });
  assert.equal(fp.full.length, 40);
  assert.equal(fp.components.area, '');
  assert.equal(fp.components.labels, '');
  assert.equal(fp.components.primaryFile, '');
});

test('fingerprintFinding tolerates a null finding', () => {
  const fp = fingerprintFinding(null);
  assert.equal(fp.full.length, 40);
});

test('fingerprintFooter round-trips through parseFingerprintFooter (AC #4)', () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const body = `Some issue body.\n\n${footer}\n`;
  assert.deepEqual(parseFingerprintFooter(body), [sha]);
});

test('fingerprintFooter rejects a non-sha argument', () => {
  assert.throws(() => fingerprintFooter('not-a-sha'));
  assert.throws(() => fingerprintFooter(null));
});

test('parseFingerprintFooter returns empty array when marker absent', () => {
  assert.deepEqual(parseFingerprintFooter('hello world'), []);
});

test('parseFingerprintFooter ignores malformed sha entries', () => {
  const body =
    '<!-- audit-fingerprints: notasha, abc, 0123456789abcdef0123456789abcdef01234567 -->';
  assert.deepEqual(parseFingerprintFooter(body), [
    '0123456789abcdef0123456789abcdef01234567',
  ]);
});

test('parseFingerprintFooter tolerates non-string input', () => {
  assert.deepEqual(parseFingerprintFooter(null), []);
  assert.deepEqual(parseFingerprintFooter(undefined), []);
});

test('routeFinding returns new when no existing issue matches (AC #1)', async () => {
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [],
  });
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
});

test('routeFinding returns update-existing for a single open match (AC #2)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 42, state: 'open', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding returns duplicate for multiple open matches (AC #2)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 42, state: 'open', body: footer },
      { number: 43, state: 'open', body: footer },
    ],
  });
  assert.equal(result.decision, 'duplicate');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding returns regression-of-closed for a closed match (AC #3)', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 99, state: 'closed', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'regression-of-closed');
  assert.equal(result.matchedIssue.number, 99);
});

test('routeFinding prefers an open match over a closed one', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 99, state: 'closed', body: footer },
      { number: 42, state: 'open', body: footer },
    ],
  });
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding ignores a search hit whose body lacks the footer', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 7, state: 'open', body: `mentions ${sha} in prose only` },
    ],
  });
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
});

test('routeFinding accepts a hit with no body (search-only confirmation)', async () => {
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [{ number: 5, state: 'open' }],
  });
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 5);
});

test('routeFinding throws when searchIssues port is missing', async () => {
  await assert.rejects(() => routeFinding(baseFinding, {}));
});

test('routeFinding exposes the fingerprint it routed on', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchIssues: async () => [],
  });
  assert.equal(result.fingerprint, sha);
});

// --- Two-stage routing: semantic candidate pass FIRST, fingerprint SECOND ---

test('routeFinding runs the semantic candidate pass first when a searchCandidates port is supplied', async () => {
  const calls = [];
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchCandidates: async (finding) => {
      calls.push('semantic');
      assert.equal(finding.title, baseFinding.title);
      return [{ number: 42, state: 'open', body: fingerprintFooter(sha) }];
    },
    searchIssues: async () => {
      calls.push('fingerprint');
      return [];
    },
  });
  // Semantic port ran; the fingerprint-only lookup did NOT (candidates came
  // from the semantic pass, then were confirmed by footer in-process).
  assert.deepEqual(calls, ['semantic']);
  assert.equal(result.decision, 'update-existing');
  assert.equal(result.matchedIssue.number, 42);
});

test('routeFinding fingerprint-confirms the semantic candidate pool (drops a similar-but-unrelated hit)', async () => {
  const result = await routeFinding(baseFinding, {
    searchCandidates: async () => [
      // Semantically similar title, but the body carries no fingerprint footer.
      { number: 7, state: 'open', title: 'SQL injection in login', body: '' },
    ],
  });
  assert.equal(result.decision, 'new');
  assert.equal(result.matchedIssue, null);
});

test('routeFinding routes a closed semantic candidate to regression-of-closed', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const result = await routeFinding(baseFinding, {
    searchCandidates: async () => [
      { number: 99, state: 'closed', body: fingerprintFooter(sha) },
    ],
  });
  assert.equal(result.decision, 'regression-of-closed');
  assert.equal(result.matchedIssue.number, 99);
});

test('routeFinding preserves the decision enum across both ports', async () => {
  const { full: sha } = fingerprintFinding(baseFinding);
  const footer = fingerprintFooter(sha);
  const viaSemantic = await routeFinding(baseFinding, {
    searchCandidates: async () => [
      { number: 1, state: 'open', body: footer },
      { number: 2, state: 'open', body: footer },
    ],
  });
  const viaFingerprint = await routeFinding(baseFinding, {
    searchIssues: async () => [
      { number: 1, state: 'open', body: footer },
      { number: 2, state: 'open', body: footer },
    ],
  });
  assert.equal(viaSemantic.decision, 'duplicate');
  assert.equal(viaFingerprint.decision, 'duplicate');
});

test('routeFinding throws when neither a searchCandidates nor a searchIssues port is supplied', async () => {
  await assert.rejects(() => routeFinding(baseFinding, {}));
  await assert.rejects(() => routeFinding(baseFinding));
});
