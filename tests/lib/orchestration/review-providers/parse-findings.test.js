/**
 * Unit tests for the shared JSON-findings parser.
 *
 * Story #4074 — the CC-30 `parseProviderFindings` body was decomposed
 * into three pure helpers. These tests pin each helper independently
 * plus the collapsed orchestration body:
 *   - unwrapEnvelope: bare array, {findings}, {result}, {data}, and the
 *     {result:{findings}} double-envelope; non-array passthrough.
 *   - coerceString: trims, rejects blank/whitespace, rejects non-strings.
 *   - buildFinding: title/body required, `message` body alias, category
 *     default vs. present, conditional file/line inclusion, null on junk.
 *   - parseProviderFindings: empty stdout, invalid JSON throw, end-to-end
 *     shape preservation across the helpers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFinding,
  coerceString,
  parseProviderFindings,
  unwrapEnvelope,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/parse-findings.js';

const identitySeverity = (raw) => (typeof raw === 'string' ? raw : 'unknown');

// --- unwrapEnvelope -------------------------------------------------------

test('unwrapEnvelope: bare array passes through unchanged', () => {
  const arr = [{ title: 'A' }];
  assert.equal(unwrapEnvelope(arr), arr);
});

test('unwrapEnvelope: {findings: []} → inner array', () => {
  const findings = [{ title: 'A' }];
  assert.equal(unwrapEnvelope({ findings }), findings);
});

test('unwrapEnvelope: {result: [...]} → result array', () => {
  const result = [{ title: 'A' }];
  assert.equal(unwrapEnvelope({ result }), result);
});

test('unwrapEnvelope: {data: [...]} → data array', () => {
  const data = [{ title: 'A' }];
  assert.equal(unwrapEnvelope({ data }), data);
});

test('unwrapEnvelope: {result: {findings: []}} double-envelope', () => {
  const findings = [{ title: 'A' }];
  assert.equal(unwrapEnvelope({ result: { findings } }), findings);
});

test('unwrapEnvelope: findings takes precedence over result/data', () => {
  const findings = [{ title: 'F' }];
  assert.equal(unwrapEnvelope({ findings, result: [], data: [] }), findings);
});

test('unwrapEnvelope: non-array, non-envelope value returned as-is', () => {
  assert.equal(unwrapEnvelope({ nope: true }).nope, true);
  assert.equal(unwrapEnvelope(null), null);
  assert.equal(unwrapEnvelope('text'), 'text');
  assert.equal(unwrapEnvelope(42), 42);
});

// --- coerceString ---------------------------------------------------------

test('coerceString: returns trimmed string for non-empty input', () => {
  assert.equal(coerceString('  hello  '), 'hello');
  assert.equal(coerceString('x'), 'x');
});

test('coerceString: blank / whitespace-only → null', () => {
  assert.equal(coerceString(''), null);
  assert.equal(coerceString('   '), null);
  assert.equal(coerceString('\n\t '), null);
});

test('coerceString: non-string inputs → null', () => {
  assert.equal(coerceString(undefined), null);
  assert.equal(coerceString(null), null);
  assert.equal(coerceString(42), null);
  assert.equal(coerceString({}), null);
  assert.equal(coerceString(['a']), null);
});

// --- buildFinding ---------------------------------------------------------

const opts = { mapSeverity: identitySeverity };

test('buildFinding: null / non-object entry → null', () => {
  assert.equal(buildFinding(null, opts), null);
  assert.equal(buildFinding(undefined, opts), null);
  assert.equal(buildFinding('string', opts), null);
  assert.equal(buildFinding(42, opts), null);
});

test('buildFinding: missing title or body → null', () => {
  assert.equal(buildFinding({ body: 'b' }, opts), null);
  assert.equal(buildFinding({ title: 't' }, opts), null);
  assert.equal(buildFinding({ title: '   ', body: 'b' }, opts), null);
  assert.equal(buildFinding({ title: 't', body: '   ' }, opts), null);
});

test('buildFinding: trims title, preserves body verbatim', () => {
  const finding = buildFinding({ title: '  T  ', body: '  B  ' }, opts);
  assert.equal(finding.title, 'T');
  assert.equal(finding.body, '  B  ');
});

test('buildFinding: `message` is a body alias when body is absent', () => {
  const finding = buildFinding({ title: 'T', message: 'M' }, opts);
  assert.equal(finding.body, 'M');
});

test('buildFinding: body wins over message when both present', () => {
  const finding = buildFinding({ title: 'T', body: 'B', message: 'M' }, opts);
  assert.equal(finding.body, 'B');
});

test('buildFinding: severity funnelled through mapSeverity', () => {
  let seen;
  const mapSeverity = (raw) => {
    seen = raw;
    return 'critical';
  };
  const finding = buildFinding(
    { title: 'T', body: 'B', severity: 'blocker' },
    { mapSeverity },
  );
  assert.equal(seen, 'blocker');
  assert.equal(finding.severity, 'critical');
});

test('buildFinding: category present on entry is preserved', () => {
  const finding = buildFinding(
    { title: 'T', body: 'B', category: 'security' },
    opts,
  );
  assert.equal(finding.category, 'security');
});

test('buildFinding: defaultCategory applied only when entry lacks one', () => {
  const withDefault = buildFinding(
    { title: 'T', body: 'B' },
    { mapSeverity: identitySeverity, defaultCategory: 'security' },
  );
  assert.equal(withDefault.category, 'security');

  const entryWins = buildFinding(
    { title: 'T', body: 'B', category: 'logic' },
    { mapSeverity: identitySeverity, defaultCategory: 'security' },
  );
  assert.equal(entryWins.category, 'logic');
});

test('buildFinding: no category key when neither entry nor default supplies one', () => {
  const finding = buildFinding({ title: 'T', body: 'B' }, opts);
  assert.equal('category' in finding, false);
});

test('buildFinding: file/line included only when well-formed', () => {
  const full = buildFinding(
    { title: 'T', body: 'B', file: 'src/x.js', line: 42 },
    opts,
  );
  assert.equal(full.file, 'src/x.js');
  assert.equal(full.line, 42);

  const empties = buildFinding(
    { title: 'T', body: 'B', file: '', line: 0 },
    opts,
  );
  assert.equal('file' in empties, false);
  assert.equal('line' in empties, false);

  const badLine = buildFinding(
    { title: 'T', body: 'B', line: 1.5 },
    opts,
  );
  assert.equal('line' in badLine, false);

  const negLine = buildFinding(
    { title: 'T', body: 'B', line: -3 },
    opts,
  );
  assert.equal('line' in negLine, false);
});

// --- parseProviderFindings (orchestration body) ---------------------------

const parseOpts = {
  errorPrefix: 'Failed to parse /test stdout',
  mapSeverity: identitySeverity,
};

test('parseProviderFindings: empty / whitespace stdout → []', () => {
  assert.deepEqual(parseProviderFindings('', parseOpts), []);
  assert.deepEqual(parseProviderFindings('   \n ', parseOpts), []);
  assert.deepEqual(parseProviderFindings(null, parseOpts), []);
  assert.deepEqual(parseProviderFindings(undefined, parseOpts), []);
});

test('parseProviderFindings: invalid JSON throws with errorPrefix', () => {
  assert.throws(
    () => parseProviderFindings('not json', parseOpts),
    /Failed to parse \/test stdout/,
  );
});

test('parseProviderFindings: non-array after unwrap → []', () => {
  assert.deepEqual(
    parseProviderFindings(JSON.stringify({ nope: true }), parseOpts),
    [],
  );
  assert.deepEqual(parseProviderFindings(JSON.stringify(42), parseOpts), []);
});

test('parseProviderFindings: bare array end-to-end with full fields', () => {
  const out = parseProviderFindings(
    JSON.stringify([
      {
        severity: 'high',
        title: 'SQL injection',
        body: 'Concatenated user input.',
        file: 'src/db.js',
        line: 42,
        category: 'security',
      },
    ]),
    parseOpts,
  );
  assert.deepEqual(out, [
    {
      severity: 'high',
      title: 'SQL injection',
      body: 'Concatenated user input.',
      file: 'src/db.js',
      line: 42,
      category: 'security',
    },
  ]);
});

test('parseProviderFindings: drops unusable entries, keeps valid ones', () => {
  const out = parseProviderFindings(
    JSON.stringify([
      { severity: 'high', title: 'keep', body: 'b' },
      { severity: 'high', title: 'no body' },
      null,
      'string',
      { severity: 'high', body: 'no title' },
    ]),
    parseOpts,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'keep');
});

test('parseProviderFindings: defaultCategory threads through to each finding', () => {
  const out = parseProviderFindings(
    JSON.stringify([{ severity: 'high', title: 'T', body: 'B' }]),
    { ...parseOpts, defaultCategory: 'security' },
  );
  assert.equal(out[0].category, 'security');
});

test('parseProviderFindings: double-envelope {result:{findings}} resolves', () => {
  const out = parseProviderFindings(
    JSON.stringify({
      result: { findings: [{ severity: 'high', title: 'X', body: 'Y' }] },
    }),
    parseOpts,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'X');
});
