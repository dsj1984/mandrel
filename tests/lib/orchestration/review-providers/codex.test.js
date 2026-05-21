/**
 * Unit tests for the Codex ReviewProvider adapter.
 *
 * Story #2830 (Epic #2815) — verifies:
 *   - Probe failure throws a hard-fail Error naming both remediations
 *     (install the plugin, or set provider: native).
 *   - Probe success returns a provider whose `runReview` is an async fn.
 *   - The Codex severity vocabulary maps onto the canonical
 *     {critical, high, medium, suggestion} enum (table-driven).
 *   - parseCodexFindings accepts bare-array, {findings: []}, and
 *     enveloped (`result` / `data`) shapes; drops entries lacking
 *     title or body; preserves file/line/category when present.
 *   - runReview surfaces a non-zero exit from the invoker as an Error
 *     and rejects invalid input shapes with TypeError.
 *   - Adapter does NOT call any GitHub provider method.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexUnavailableError,
  CODEX_REMEDIATIONS,
  CODEX_SEVERITY_MAP,
  createCodexProvider,
  defaultProbeCodexCommand,
  mapCodexSeverity,
  parseCodexFindings,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/codex.js';

const ALLOWED_SEVERITIES = new Set([
  'critical',
  'high',
  'medium',
  'suggestion',
]);

const presentProbe = () => true;
const absentProbe = () => false;

test('createCodexProvider: probe absent throws hard-fail Error naming both remediations', () => {
  assert.throws(
    () => createCodexProvider({ probeFn: absentProbe }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(CODEX_REMEDIATIONS.install));
      assert.ok(err.message.includes(CODEX_REMEDIATIONS.fallback));
      assert.match(err.message, /openai\/codex-plugin-cc/);
      assert.match(err.message, /provider.*native/);
      return true;
    },
  );
});

test('buildCodexUnavailableError: message names install + fallback verbatim', () => {
  const err = buildCodexUnavailableError();
  assert.ok(err.message.includes(CODEX_REMEDIATIONS.install));
  assert.ok(err.message.includes(CODEX_REMEDIATIONS.fallback));
});

test('createCodexProvider: probe present returns a ReviewProvider with runReview', () => {
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
  });
  assert.equal(typeof provider.runReview, 'function');
});

test('defaultProbeCodexCommand: returns false when no markers exist', () => {
  const result = defaultProbeCodexCommand({
    markers: ['/definitely/not/a/path'],
    existsFn: () => false,
  });
  assert.equal(result, false);
});

test('defaultProbeCodexCommand: returns true when a marker exists', () => {
  const result = defaultProbeCodexCommand({
    markers: ['/some/marker'],
    existsFn: (p) => p === '/some/marker',
  });
  assert.equal(result, true);
});

test('defaultProbeCodexCommand: treats existsFn throws as absent (no crash)', () => {
  const result = defaultProbeCodexCommand({
    markers: ['/boom'],
    existsFn: () => {
      throw new Error('EACCES');
    },
  });
  assert.equal(result, false);
});

test('mapCodexSeverity: table-driven coverage of the Codex severity vocabulary', () => {
  const cases = [
    // [input, expectedCanonicalSeverity]
    ['blocker', 'critical'],
    ['BLOCKER', 'critical'],
    ['critical', 'critical'],
    ['fatal', 'critical'],
    ['major', 'high'],
    ['high', 'high'],
    ['error', 'high'],
    ['minor', 'medium'],
    ['medium', 'medium'],
    ['warning', 'medium'],
    ['Warning', 'medium'],
    ['info', 'suggestion'],
    ['nit', 'suggestion'],
    ['style', 'suggestion'],
    ['suggestion', 'suggestion'],
    ['note', 'suggestion'],
    // Defensive fallthrough: unknown tokens collapse to suggestion.
    ['xyzzy', 'suggestion'],
    ['', 'suggestion'],
    [undefined, 'suggestion'],
    [42, 'suggestion'],
    [null, 'suggestion'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      mapCodexSeverity(input),
      expected,
      `mapCodexSeverity(${JSON.stringify(input)}) → ${expected}`,
    );
  }
});

test('CODEX_SEVERITY_MAP: every value is in the canonical set', () => {
  for (const [key, value] of Object.entries(CODEX_SEVERITY_MAP)) {
    assert.ok(
      ALLOWED_SEVERITIES.has(value),
      `CODEX_SEVERITY_MAP[${key}] = ${value} must be in the canonical set`,
    );
  }
});

test('parseCodexFindings: empty stdout → []', () => {
  assert.deepEqual(parseCodexFindings(''), []);
  assert.deepEqual(parseCodexFindings('   \n  '), []);
});

test('parseCodexFindings: bare array of findings', () => {
  const out = parseCodexFindings(
    JSON.stringify([
      {
        severity: 'blocker',
        title: 'SQL injection',
        body: 'Concatenated user input into a query.',
        file: 'src/db.js',
        line: 42,
        category: 'security',
      },
    ]),
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    severity: 'critical',
    title: 'SQL injection',
    body: 'Concatenated user input into a query.',
    file: 'src/db.js',
    line: 42,
    category: 'security',
  });
});

test('parseCodexFindings: {findings: []} envelope', () => {
  const out = parseCodexFindings(
    JSON.stringify({
      findings: [
        { severity: 'major', title: 'A', body: 'B' },
        { severity: 'nit', title: 'C', body: 'D' },
      ],
    }),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].severity, 'high');
  assert.equal(out[1].severity, 'suggestion');
});

test('parseCodexFindings: {result: {findings: []}} double-envelope', () => {
  const out = parseCodexFindings(
    JSON.stringify({
      result: { findings: [{ severity: 'critical', title: 'X', body: 'Y' }] },
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
});

test('parseCodexFindings: {data: [...]} envelope', () => {
  const out = parseCodexFindings(
    JSON.stringify({
      data: [{ severity: 'info', title: 'X', body: 'Y' }],
    }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'suggestion');
});

test('parseCodexFindings: drops entries missing title or body', () => {
  const out = parseCodexFindings(
    JSON.stringify([
      { severity: 'major', title: 'has both', body: 'body' },
      { severity: 'major', title: 'no body' },
      { severity: 'major', body: 'no title' },
      { severity: 'major', title: '   ', body: 'blank title' },
      null,
      'string',
    ]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'has both');
});

test('parseCodexFindings: accepts `message` as a body alias', () => {
  const out = parseCodexFindings(
    JSON.stringify([{ severity: 'major', title: 'T', message: 'M' }]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].body, 'M');
});

test('parseCodexFindings: invalid JSON throws (orchestrator owns envelope)', () => {
  assert.throws(
    () => parseCodexFindings('not json'),
    /Failed to parse \/codex:review stdout/,
  );
});

test('runReview: returns parsed Finding[] with canonical severities', async () => {
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: () => ({
      status: 0,
      stdout: JSON.stringify({
        findings: [
          { severity: 'blocker', title: 'A', body: 'a' },
          { severity: 'major', title: 'B', body: 'b' },
          { severity: 'minor', title: 'C', body: 'c' },
          { severity: 'nit', title: 'D', body: 'd' },
        ],
      }),
      stderr: '',
    }),
  });
  const findings = await provider.runReview({
    scope: 'epic',
    ticketId: 2815,
    baseRef: 'main',
    headRef: 'epic/2815',
  });
  assert.deepEqual(
    findings.map((f) => f.severity),
    ['critical', 'high', 'medium', 'suggestion'],
  );
  for (const f of findings) {
    assert.ok(ALLOWED_SEVERITIES.has(f.severity));
  }
});

test('runReview: invokeFn receives baseRef + headRef + scope + ticketId', async () => {
  let captured = null;
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: (args) => {
      captured = args;
      return { status: 0, stdout: '[]', stderr: '' };
    },
  });
  await provider.runReview({
    scope: 'story',
    ticketId: 2830,
    baseRef: 'epic/2815',
    headRef: 'story-2830',
  });
  assert.deepEqual(captured, {
    baseRef: 'epic/2815',
    headRef: 'story-2830',
    scope: 'story',
    ticketId: 2830,
  });
});

test('runReview: non-zero invoker exit throws with stderr surfaced', async () => {
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: () => ({ status: 2, stdout: '', stderr: 'plugin crashed' }),
  });
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 2815,
        baseRef: 'main',
        headRef: 'epic/2815',
      }),
    /\/codex:review exited with status 2.*plugin crashed/,
  );
});

test('runReview: rejects invalid input shapes with TypeError', async () => {
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
  });
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 0,
        baseRef: 'main',
        headRef: 'epic/0',
      }),
    TypeError,
  );
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 42,
        baseRef: '',
        headRef: 'epic/42',
      }),
    TypeError,
  );
});

test('runReview: never invokes a GitHub provider method', async () => {
  // The adapter does not receive a GitHub provider at all — verifying the
  // shape contract: createCodexProvider takes no provider, and runReview
  // returns Finding[] without any external posting.
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
  });
  const findings = await provider.runReview({
    scope: 'epic',
    ticketId: 1,
    baseRef: 'main',
    headRef: 'epic/1',
  });
  assert.ok(Array.isArray(findings));
});
