/**
 * Unit tests for `security-review.js` — Story #2871.
 *
 * Verifies:
 *   - Probe failure throws the canonical remediation Error (the
 *     chain treats it as a skip when entry is `optional: true`).
 *   - JSON output parses into canonical Finding[] with severity
 *     mapping.
 *   - Non-JSON output collapses to a single advisory suggestion
 *     (no false high-risk; no chain halt).
 *   - The provider NEVER posts to GitHub — it returns findings
 *     and the orchestrator owns persistence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSecurityReviewPrompt,
  buildSecurityReviewUnavailableError,
  buildUnparseableFallbackFinding,
  createSecurityReviewProvider,
  mapSecurityReviewSeverity,
  parseSecurityReviewFindings,
  SECURITY_REVIEW_REMEDIATIONS,
  SECURITY_REVIEW_SEVERITY_MAP,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/security-review.js';

test('mapSecurityReviewSeverity: maps every canonical key', () => {
  for (const [raw, expected] of Object.entries(SECURITY_REVIEW_SEVERITY_MAP)) {
    assert.equal(
      mapSecurityReviewSeverity(raw),
      expected,
      `${raw} → ${expected}`,
    );
    assert.equal(
      mapSecurityReviewSeverity(raw.toUpperCase()),
      expected,
      `${raw.toUpperCase()} → ${expected}`,
    );
  }
});

test('mapSecurityReviewSeverity: unknown / non-string → suggestion', () => {
  assert.equal(mapSecurityReviewSeverity('unknown'), 'suggestion');
  assert.equal(mapSecurityReviewSeverity(undefined), 'suggestion');
  assert.equal(mapSecurityReviewSeverity(null), 'suggestion');
  assert.equal(mapSecurityReviewSeverity(42), 'suggestion');
});

test('buildSecurityReviewUnavailableError: includes both remediations', () => {
  const err = buildSecurityReviewUnavailableError();
  assert.ok(err instanceof Error);
  assert.ok(err.message.includes(SECURITY_REVIEW_REMEDIATIONS.install));
  assert.ok(err.message.includes(SECURITY_REVIEW_REMEDIATIONS.fallback));
});

test('parseSecurityReviewFindings: bare JSON array', () => {
  const stdout = JSON.stringify([
    {
      severity: 'critical',
      title: 'Auth bypass',
      body: 'Endpoint accepts a forged JWT.',
      file: 'src/auth.js',
      line: 42,
    },
    {
      severity: 'medium',
      title: 'Verbose error',
      body: 'Stack trace leaks DB schema.',
    },
  ]);
  const findings = parseSecurityReviewFindings(stdout);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].title, 'Auth bypass');
  assert.equal(findings[0].file, 'src/auth.js');
  assert.equal(findings[0].line, 42);
  assert.equal(findings[0].category, 'security');
  assert.equal(findings[1].severity, 'medium');
});

test('parseSecurityReviewFindings: { findings: [...] } envelope', () => {
  const stdout = JSON.stringify({
    findings: [{ severity: 'high', title: 't', body: 'b' }],
  });
  const findings = parseSecurityReviewFindings(stdout);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
});

test('parseSecurityReviewFindings: { result: [...] } envelope', () => {
  const stdout = JSON.stringify({
    result: [{ severity: 'critical', title: 't', body: 'b' }],
  });
  const findings = parseSecurityReviewFindings(stdout);
  assert.equal(findings.length, 1);
});

test('parseSecurityReviewFindings: empty stdout → []', () => {
  assert.deepEqual(parseSecurityReviewFindings(''), []);
  assert.deepEqual(parseSecurityReviewFindings('   '), []);
});

test('parseSecurityReviewFindings: drops entries missing title or body', () => {
  const stdout = JSON.stringify([
    { severity: 'high', title: '', body: 'b' },
    { severity: 'high', title: 't', body: '' },
    { severity: 'high', title: 't', body: 'b' },
  ]);
  const findings = parseSecurityReviewFindings(stdout);
  assert.equal(findings.length, 1);
});

test('parseSecurityReviewFindings: non-JSON throws', () => {
  assert.throws(
    () => parseSecurityReviewFindings('not json'),
    /Failed to parse/,
  );
});

test('buildSecurityReviewPrompt: substitutes scope/refs/ticketId', () => {
  const prompt = buildSecurityReviewPrompt({
    scope: 'epic',
    ticketId: 42,
    baseRef: 'main',
    headRef: 'epic/42',
  });
  assert.match(prompt, /Epic/);
  assert.match(prompt, /`main`/);
  assert.match(prompt, /`epic\/42`/);
  assert.match(prompt, /#42/);
  assert.match(prompt, /JSON/);
});

test('buildUnparseableFallbackFinding: suggestion severity, security category', () => {
  const f = buildUnparseableFallbackFinding();
  assert.equal(f.severity, 'suggestion');
  assert.equal(f.category, 'security');
  assert.match(f.title, /not parseable/i);
});

test('createSecurityReviewProvider: probe failure throws unavailable error', () => {
  assert.throws(
    () => createSecurityReviewProvider({ probeFn: () => false }),
    /claude.*CLI/i,
  );
});

test('createSecurityReviewProvider: present probe returns provider', () => {
  const provider = createSecurityReviewProvider({
    probeFn: () => true,
    invokeFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
  });
  assert.equal(typeof provider.runReview, 'function');
});

test('runReview: parses JSON output into Finding[]', async () => {
  const provider = createSecurityReviewProvider({
    probeFn: () => true,
    invokeFn: () => ({
      status: 0,
      stdout: JSON.stringify([
        { severity: 'critical', title: 'XSS', body: 'b', file: 'a.js' },
      ]),
      stderr: '',
    }),
  });
  const findings = await provider.runReview({
    scope: 'epic',
    ticketId: 42,
    baseRef: 'main',
    headRef: 'epic/42',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].category, 'security');
});

test('runReview: non-zero invoker exit throws with stderr surfaced', async () => {
  const provider = createSecurityReviewProvider({
    probeFn: () => true,
    invokeFn: () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
  });
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 1,
        baseRef: 'a',
        headRef: 'b',
      }),
    /permission denied/,
  );
});

test('runReview: unparseable JSON degrades to advisory fallback finding', async () => {
  const provider = createSecurityReviewProvider({
    probeFn: () => true,
    invokeFn: () => ({ status: 0, stdout: 'free text response', stderr: '' }),
  });
  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 1,
    baseRef: 'a',
    headRef: 'b',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'suggestion');
  assert.equal(findings[0].category, 'security');
});

test('runReview: rejects invalid input shapes with TypeError', async () => {
  const provider = createSecurityReviewProvider({
    probeFn: () => true,
    invokeFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
  });
  await assert.rejects(
    () => provider.runReview({ scope: 'epic', ticketId: 1, baseRef: 'a' }),
    TypeError,
  );
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 0,
        baseRef: 'a',
        headRef: 'b',
      }),
    TypeError,
  );
});
