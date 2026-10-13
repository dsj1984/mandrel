/**
 * Unit tests for the Codex ReviewProvider adapter.
 *
 * Story #2830 (Epic #2815) — verifies:
 *   - Probe failure throws a hard-fail Error naming both remediations
 *     (install the Codex CLI + `codex login`, or set provider: native).
 *   - The probe runs `codex --version`; the default invoke spawns
 *     `codex exec` (read-only sandbox, ephemeral, output schema, last
 *     message under the tempRoot) and never `claude`.
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { invokeCodexExec } from '../../../../.agents/scripts/lib/orchestration/review-providers/codex-cli.js';

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
      assert.match(err.message, /Codex CLI/);
      assert.match(err.message, /codex login/);
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

test('defaultProbeCodexCommand: runs `codex --version` with a timeout', () => {
  const calls = [];
  const result = defaultProbeCodexCommand({
    run: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0, stdout: 'codex-cli 0.50.0', stderr: '' };
    },
  });
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'codex');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.ok(calls[0].options.timeout > 0);
});

test('defaultProbeCodexCommand: non-zero or null exit reads as absent', () => {
  assert.equal(defaultProbeCodexCommand({ run: () => ({ status: 1 }) }), false);
  assert.equal(
    defaultProbeCodexCommand({ run: () => ({ status: null }) }),
    false,
  );
});

test('defaultProbeCodexCommand: a spawn throw reads as absent (no crash)', () => {
  const result = defaultProbeCodexCommand({
    run: () => {
      throw new Error('ENOENT');
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
    /\[codex-review\] Failed to parse codex exec output/,
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

test('runReview: invokeFn receives baseRef + headRef + scope + ticketId + depth', async () => {
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
    depth: 'deep',
  });
  assert.deepEqual(captured, {
    baseRef: 'epic/2815',
    headRef: 'story-2830',
    scope: 'story',
    ticketId: 2830,
    depth: 'deep',
  });
});

test('runReview: non-zero invoker exit throws with stderr surfaced', async () => {
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: () => ({ status: 2, stdout: '', stderr: 'codex crashed' }),
  });
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'epic',
        ticketId: 2815,
        baseRef: 'main',
        headRef: 'epic/2815',
      }),
    /\[codex-review\] codex exec exited with status 2.*codex crashed/,
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

test('runReview: preserves title/body/file/line/category from schema output', async () => {
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: async () => ({
      status: 0,
      stdout: JSON.stringify({
        findings: [
          {
            severity: 'major',
            title: 'Off by one',
            body: 'Loop skips the last row.',
            file: 'src/a.js',
            line: 7,
            category: 'correctness',
          },
          {
            severity: 'nit',
            title: 'Global',
            body: 'No location.',
            file: null,
            line: null,
            category: 'style',
          },
        ],
      }),
      stderr: '',
    }),
  });
  const findings = await provider.runReview({
    scope: 'story',
    ticketId: 5656,
    baseRef: 'main',
    headRef: 'story-5656',
  });
  assert.deepEqual(findings, [
    {
      severity: 'high',
      title: 'Off by one',
      body: 'Loop skips the last row.',
      file: 'src/a.js',
      line: 7,
      category: 'correctness',
    },
    {
      severity: 'suggestion',
      title: 'Global',
      body: 'No location.',
      category: 'style',
    },
  ]);
});

test('runReview: unparseable output throws a [codex-review] error', async () => {
  const provider = createCodexProvider({
    probeFn: presentProbe,
    invokeFn: () => ({ status: 0, stdout: 'not json', stderr: '' }),
  });
  await assert.rejects(
    () =>
      provider.runReview({
        scope: 'story',
        ticketId: 1,
        baseRef: 'main',
        headRef: 'story-1',
      }),
    /^Error: \[codex-review\]/,
  );
});

/** A fake `codex exec` runner that records its call and writes `-o`. */
function fakeCodexRun({ lastMessage, status = 0, stderr = '' }) {
  const calls = [];
  const run = async (file, args, options) => {
    const schemaPath = args[args.indexOf('--output-schema') + 1];
    const outPath = args[args.indexOf('-o') + 1];
    calls.push({
      file,
      args,
      options,
      schema: JSON.parse(fs.readFileSync(schemaPath, 'utf8')),
      outPath,
    });
    if (lastMessage !== undefined) fs.writeFileSync(outPath, lastMessage);
    return { status, stdout: 'progress chatter', stderr };
  };
  return { run, calls };
}

/** Codex structured output is strict: every property required, no extras. */
function assertStrictFindingsSchema(schema) {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['findings']);
  const item = schema.properties.findings.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual([...item.required].sort(), [
    'body',
    'category',
    'file',
    'line',
    'severity',
    'title',
  ]);
  assert.deepEqual(
    Object.keys(item.properties).sort(),
    [...item.required].sort(),
  );
  assert.deepEqual(
    item.properties.severity.enum,
    Object.keys(CODEX_SEVERITY_MAP),
  );
  assert.deepEqual(item.properties.file.type, ['string', 'null']);
  assert.deepEqual(item.properties.line.type, ['integer', 'null']);
}

function makeTempRoot() {
  // test-temp-allow: an isolated tempRoot stand-in, removed by the caller.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-test-'));
}

test('invokeCodexExec: spawns codex exec (read-only, ephemeral, schema, -o under tempRoot) — never claude', async (t) => {
  const tempRoot = makeTempRoot();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const { run, calls } = fakeCodexRun({
    lastMessage: JSON.stringify({ findings: [] }),
  });
  const result = await invokeCodexExec(
    { baseRef: 'main', headRef: 'story-5656', depth: 'deep' },
    { run, tempRoot, cwd: tempRoot },
  );
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.file, 'codex');
  assert.notEqual(call.file, 'claude');
  assert.equal(call.args[0], 'exec');
  const sandboxAt = call.args.indexOf('--sandbox');
  assert.ok(sandboxAt > 0);
  assert.equal(call.args[sandboxAt + 1], 'read-only');
  assert.ok(call.args.includes('--ephemeral'));
  assertStrictFindingsSchema(call.schema);
  assert.ok(call.outPath.startsWith(tempRoot + path.sep));
  assert.match(call.options.input, /main\.\.\.story-5656/);
  assert.match(call.options.input, /deep/i);
  assert.match(call.options.input, /schema/);
  assert.deepEqual(result, {
    status: 0,
    stdout: JSON.stringify({ findings: [] }),
    stderr: '',
  });
  assert.deepEqual(fs.readdirSync(tempRoot), [], 'per-run dir is removed');
});

test('invokeCodexExec: non-zero exit is returned as-is and the run dir is removed', async (t) => {
  const tempRoot = makeTempRoot();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const { run } = fakeCodexRun({ status: 3, stderr: 'not logged in' });
  const result = await invokeCodexExec(
    { baseRef: 'main', headRef: 'h' },
    { run, tempRoot, cwd: tempRoot },
  );
  assert.equal(result.status, 3);
  assert.equal(result.stderr, 'not logged in');
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('invokeCodexExec: a missing last-message file is a failure, not an empty review', async (t) => {
  const tempRoot = makeTempRoot();
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const { run } = fakeCodexRun({});
  const result = await invokeCodexExec(
    { baseRef: 'main', headRef: 'h' },
    { run, tempRoot, cwd: tempRoot },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no last-message file/);
});
