/**
 * Unit tests for `review-providers/code-review.js` — Stories #5426, #5663.
 *
 * Every test injects the probe, git and `claude` spawn seams: none spawns
 * the real `claude` binary.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasSurvivingCritical } from '../../../../.agents/scripts/lib/audit-suite/findings.js';
import { spawnCaptureAsync } from '../../../../.agents/scripts/lib/child-exec.js';
import { createCodeReviewProviderForRegistry } from '../../../../.agents/scripts/lib/orchestration/review-providers/code-review.js';
import {
  mergeChainDegradations,
  renderDegradedGatesSection,
} from '../../../../.agents/scripts/lib/orchestration/review-providers/degraded-gates.js';

const INPUT = Object.freeze({
  scope: 'story',
  ticketId: 5426,
  baseRef: 'origin/main',
  headRef: 'story-5426',
  depth: 'standard',
  labels: ['type::story'],
});

const DIFF = 'diff --git a/src/a.js b/src/a.js\n+const x = 1;\n';
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../..');

const AUTH_OK = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  subscriptionType: 'max',
  email: 'operator@example.com',
  orgId: 'org-123',
  orgName: 'Example Org',
});

/** A successful `--output-format json` envelope carrying `findings`. */
function envelope(findings, extra = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: { findings },
    ...extra,
  });
}

/**
 * @param {{ stdout?: string, status?: number, stderr?: string, diff?: object, grep?: Function, auth?: object, logger?: object }} [opts]
 */
function harness(opts = {}) {
  const calls = [];
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    // Pinned so argv assertions do not depend on the host's shell quoting.
    platform: opts.platform ?? 'linux',
    logger: opts.logger,
    gitSpawnFn: (cwd, ...args) => {
      if (args[0] === 'grep') {
        calls.push({ kind: 'grep', cwd, args });
        return opts.grep?.(args) ?? { status: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'check-attr') {
        return opts.attr?.(args) ?? { status: 0, stdout: '', stderr: '' };
      }
      calls.push({ kind: 'diff', cwd, args });
      return opts.diff ?? { status: 0, stdout: DIFF, stderr: '' };
    },
    authSpawnFn: (file, args, options) => {
      calls.push({
        kind: 'auth',
        file,
        args: [...args],
        options,
        cwdExisted: fs.existsSync(options.cwd),
      });
      return opts.auth ?? { status: 0, stdout: AUTH_OK, stderr: '' };
    },
    spawnFn: (file, args, options) => {
      calls.push({
        kind: 'invoke',
        file,
        args: [...args],
        options,
        cwdExisted: fs.existsSync(options.cwd),
      });
      return {
        status: opts.status ?? 0,
        stdout: opts.stdout ?? envelope([]),
        stderr: opts.stderr ?? '',
      };
    },
  });
  return { provider, calls };
}

function invokeCall(calls) {
  const call = calls.find((c) => c.kind === 'invoke');
  return call && { ...call, prompt: call.options.input };
}

function countSeverity(findings) {
  const out = { critical: 0, high: 0, medium: 0, suggestion: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

/** Exactly one degraded-gate record for the model bug review. */
function assertOneDegradation(provider, reasonRe) {
  const rows = provider.getDegradations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'code-review');
  assert.equal(rows[0].gate, 'codeReview');
  assert.equal(rows[0].surface, 'model-bug-review');
  assert.match(rows[0].reason, reasonRe);
  return rows[0];
}

test('construction throws when the claude CLI probe reports absent', () => {
  assert.throws(
    () => createCodeReviewProviderForRegistry({ probeFn: () => false }),
    /"code-review" requires the `claude` CLI/,
  );
});

test('AC-3: invokes claude with structured output and stripped context, no --model or --bare', async () => {
  const { provider, calls } = harness();
  await provider.runReview(INPUT);
  const call = invokeCall(calls);
  assert.equal(call.file, 'claude');
  const { args } = call;
  assert.deepEqual(args.slice(0, 3), ['--print', '--effort', 'low']);
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.required, ['findings']);
  assert.equal(schema.properties.findings.type, 'array');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(!args.includes('--model'), 'no model pin');
  assert.ok(!args.includes('--bare'), 'no --bare (would force API-key auth)');
  assert.ok(call.options.timeout > 0, 'bounded timeout');
  const diffCall = calls.find((c) => c.kind === 'diff');
  assert.deepEqual(diffCall.args, [
    'diff',
    '--no-color',
    'origin/main...story-5426',
  ]);
  assert.match(call.prompt, /origin\/main\.\.\.story-5426/);
  assert.match(call.prompt, /Story #5426/);
  assert.ok(call.prompt.includes(DIFF), 'diff text is handed over');
});

test('AC-3: the review runs from a fresh OS temp dir outside the project, removed after the run', async () => {
  const { provider, calls } = harness();
  await provider.runReview(INPUT);
  const { options, cwdExisted } = invokeCall(calls);
  const cwd = path.resolve(options.cwd);
  assert.ok(cwdExisted, 'cwd existed during the run');
  assert.ok(
    cwd.startsWith(path.resolve(os.tmpdir()) + path.sep),
    `cwd ${cwd} is under os.tmpdir()`,
  );
  assert.match(path.basename(cwd), /^mandrel-code-review-/);
  assert.ok(
    !cwd.startsWith(PROJECT_ROOT + path.sep),
    'cwd is outside the project root',
  );
  assert.equal(fs.existsSync(cwd), false, 'temp dir removed after the run');
  const auth = calls.find((c) => c.kind === 'auth');
  assert.equal(auth.options.cwd, options.cwd, 'preflight shares the temp dir');
});

test('the temp dir is removed even when the reviewer spawn throws', async () => {
  let seenCwd = null;
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    gitSpawnFn: () => ({ status: 0, stdout: DIFF, stderr: '' }),
    authSpawnFn: () => ({ status: 0, stdout: AUTH_OK, stderr: '' }),
    spawnFn: (_f, _a, options) => {
      seenCwd = options.cwd;
      throw new Error('boom');
    },
  });
  await assert.rejects(() => provider.runReview(INPUT), /boom/);
  assert.ok(seenCwd);
  assert.equal(fs.existsSync(seenCwd), false);
});

test('on win32 the shell-joined argv is quoted so the empty --tools value and the schema survive', async () => {
  const seen = [];
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    platform: 'win32',
    gitSpawnFn: () => ({ status: 0, stdout: DIFF, stderr: '' }),
    authSpawnFn: (_f, args, options) => {
      seen.push({ args, options });
      return { status: 0, stdout: AUTH_OK, stderr: '' };
    },
    spawnFn: (_f, args, options) => {
      seen.push({ args, options });
      return { status: 0, stdout: envelope([]), stderr: '' };
    },
  });
  assert.deepEqual(await provider.runReview(INPUT), []);
  const review = seen[1];
  assert.equal(review.options.shell, true);
  assert.ok(review.args.includes('""'), 'empty --tools value quoted');
  assert.ok(review.args.every((a) => a.startsWith('"') && a.endsWith('"')));
  assert.ok(review.args.some((a) => a.includes('\\"findings\\"')));
});

test('prompt asks only for merge-blocking problems with file, line, why and how to show it fails', async () => {
  const { provider, calls } = harness();
  await provider.runReview(INPUT);
  const { prompt } = invokeCall(calls);
  assert.match(prompt, /ONLY problems you would block this merge for/);
  assert.match(prompt, /the file/);
  assert.match(prompt, /the\s+line/);
  assert.match(prompt, /why it is wrong/);
  assert.match(prompt, /how to show it fails/);
  assert.match(prompt, /Emit \{"findings":\[\]\} if there is nothing/);
});

test('prompt reads a shortcut: comment with ceiling and trigger as a decision', async () => {
  const { provider, calls } = harness();
  await provider.runReview({ ...INPUT, depth: 'light' });
  const { prompt } = invokeCall(calls);
  assert.match(
    prompt,
    /A `shortcut:` comment naming its ceiling and trigger is a decision, not a finding, unless this diff itself crosses the ceiling\./,
  );
});

test('prompt carries no acceptance criteria or self-eval verdict', async () => {
  const { provider, calls } = harness();
  await provider.runReview({
    ...INPUT,
    acceptance: ['AC-1: SENTINEL_ACCEPTANCE'],
    verdict: { verdict: 'SENTINEL_VERDICT' },
  });
  const { prompt } = invokeCall(calls);
  assert.doesNotMatch(prompt, /acceptance/i);
  assert.doesNotMatch(prompt, /SENTINEL_ACCEPTANCE|SENTINEL_VERDICT/);
  assert.doesNotMatch(prompt, /self-eval|verdict/i);
});

test('AC-1: structured_output findings are all critical with category defaulting to bug, so the chain halts', async () => {
  const stdout = envelope([
    {
      severity: 'suggestion',
      title: 'Off-by-one drops the last row',
      body: 'Why it is wrong: ... How to show it fails: ...',
      file: 'src/a.js',
      line: 1,
    },
    { severity: 'medium', title: 'Null deref', body: 'crashes on empty input' },
  ]);
  const { provider } = harness({ stdout });
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.severity === 'critical'));
  assert.ok(findings.every((f) => f.category === 'bug'));
  assert.equal(findings[0].file, 'src/a.js');
  assert.equal(findings[0].line, 1);
  assert.equal(hasSurvivingCritical(countSeverity(findings)), true);
  assert.deepEqual(provider.getDegradations(), []);
});

test('AC-1: structured_output with an empty findings list lets close proceed with no degradation', async () => {
  const { provider } = harness({ stdout: envelope([]) });
  const findings = await provider.runReview(INPUT);
  assert.deepEqual(findings, []);
  assert.equal(hasSurvivingCritical(countSeverity(findings)), false);
  assert.deepEqual(provider.getDegradations(), []);
});

test('AC-2: prose before a fenced JSON array in the result text is a real verdict', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'The change is a one-line default swap.\n\n```json\n[]\n```',
  });
  const { provider } = harness({ stdout });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assert.deepEqual(provider.getDegradations(), []);
});

test('AC-2: the last fenced block wins and may carry a findings object', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result:
      'Draft:\n```json\n[]\n```\nRevised after a second look:\n```json\n{"findings":[{"title":"t","body":"b"}]}\n```\n',
  });
  const { provider } = harness({ stdout });
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].category, 'bug');
});

test('AC-2: prose around a bare JSON array parses the last top-level array', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result:
      'I checked [the diff] carefully. Result:\n[{"title":"Crash on [] input","body":"b","line":3}]\nDone.',
  });
  const { provider } = harness({ stdout });
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, 'Crash on [] input');
  assert.equal(findings[0].line, 3);
});

test('AC-4: unparseable result text is one degradation and no findings', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Looks good to me!',
  });
  const { provider } = harness({ stdout });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assertOneDegradation(provider, /did not parse as a findings verdict/);
});

test('AC-4: stdout that is not a JSON envelope is one degradation', async () => {
  const { provider } = harness({ stdout: 'Looks good to me!' });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assertOneDegradation(provider, /not a JSON result envelope/);
});

test('AC-4: a non-zero claude exit is one degradation naming the status', async () => {
  const { provider } = harness({ status: 1, stdout: '', stderr: 'boom' });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assertOneDegradation(provider, /exited with status 1: boom/);
});

test('AC-4: is_error: true is one degradation even with a parseable result', async () => {
  const stdout = envelope([], { is_error: true, result: 'API Error: 500' });
  const { provider } = harness({ stdout });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assertOneDegradation(provider, /error result: API Error: 500/);
});

test('AC-4: a non-success subtype is one degradation', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: false,
    result: '[]',
  });
  const { provider } = harness({ stdout });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assertOneDegradation(provider, /subtype error_max_turns/);
});

test('AC-4: an unreadable diff is one degradation without invoking claude', async () => {
  const { provider, calls } = harness({
    diff: { status: 128, stdout: '', stderr: 'bad revision' },
  });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assertOneDegradation(
    provider,
    /git diff origin\/main\.\.\.story-5426 failed: bad revision/,
  );
  assert.equal(invokeCall(calls), undefined);
  assert.equal(
    calls.find((c) => c.kind === 'auth'),
    undefined,
  );
});

test('AC-4: the degradation reaches the chain and renders under Degraded Gates; no suggestion finding', async () => {
  const { provider } = harness({ status: 1, stdout: '', stderr: 'boom' });
  const findings = await provider.runReview(INPUT);
  assert.equal(countSeverity(findings).suggestion, 0);
  const merged = await mergeChainDegradations([
    { name: 'code-review', provider },
  ]);
  assert.equal(merged.length, 1);
  const comment = renderDegradedGatesSection(merged).join('\n');
  assert.match(comment, /Degraded Gates/);
  assert.match(comment, /model-bug-review/);
});

test('AC-5: a not-logged-in preflight skips the review and names the login problem', async () => {
  const { provider, calls } = harness({
    auth: {
      status: 0,
      stdout: JSON.stringify({
        loggedIn: false,
        authMethod: 'none',
        email: 'operator@example.com',
      }),
      stderr: '',
    },
  });
  assert.deepEqual(await provider.runReview(INPUT), []);
  const row = assertOneDegradation(
    provider,
    /not logged in \(authMethod: none\)/,
  );
  assert.doesNotMatch(row.reason, /operator@example\.com/);
  assert.equal(invokeCall(calls), undefined);
});

test('AC-5: a non-zero or unparseable preflight skips the review', async () => {
  const exited = harness({ auth: { status: 1, stdout: '', stderr: 'nope' } });
  assert.deepEqual(await exited.provider.runReview(INPUT), []);
  assertOneDegradation(
    exited.provider,
    /auth status exited 1: the CLI is not logged in/,
  );
  assert.equal(invokeCall(exited.calls), undefined);

  const garbled = harness({
    auth: { status: 0, stdout: 'not json', stderr: '' },
  });
  assert.deepEqual(await garbled.provider.runReview(INPUT), []);
  assertOneDegradation(garbled.provider, /unparseable output/);
  assert.equal(invokeCall(garbled.calls), undefined);
});

test('AC-5: a usage-limit failure names quota exhaustion', async () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: "You've hit your weekly limit · resets Oct 14",
  });
  const { provider } = harness({ status: 1, stdout });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assertOneDegradation(provider, /out of quota/);
});

test('AC-5: no reason or log line carries the account email, org name or org id', async () => {
  const lines = [];
  const logger = {
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
  };
  const ok = harness({ logger });
  await ok.provider.runReview(INPUT);
  const failed = harness({ logger, status: 1, stdout: '', stderr: 'boom' });
  await failed.provider.runReview(INPUT);
  const text = [
    ...lines,
    ...failed.provider.getDegradations().map((d) => d.reason),
  ].join('\n');
  assert.match(text, /authMethod: claude\.ai, subscriptionType: max/);
  assert.doesNotMatch(text, /operator@example\.com|Example Org|org-123/);
});

test('AC-6: a failed review then a successful one reports no degradation for the second run', async () => {
  let run = 0;
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    gitSpawnFn: () => ({ status: 0, stdout: DIFF, stderr: '' }),
    authSpawnFn: () => ({ status: 0, stdout: AUTH_OK, stderr: '' }),
    spawnFn: () => {
      run += 1;
      return run === 1
        ? { status: 1, stdout: '', stderr: 'boom' }
        : { status: 0, stdout: envelope([]), stderr: '' };
    },
  });
  await provider.runReview(INPUT);
  assert.equal(provider.getDegradations().length, 1);
  assert.deepEqual(await provider.runReview(INPUT), []);
  assert.deepEqual(provider.getDegradations(), []);
});

test('an empty diff returns no findings without invoking claude', async () => {
  const { provider, calls } = harness({
    diff: { status: 0, stdout: '\n', stderr: '' },
  });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assert.equal(invokeCall(calls), undefined);
  assert.deepEqual(provider.getDegradations(), []);
});

test('#5878 AC-3: a single file over the cap is reviewed alone, truncated, and degraded by name', async () => {
  const big = `diff --git a/x b/x\n${'+'.repeat(250_000)}\n`;
  const { provider, calls } = harness({
    diff: { status: 0, stdout: big, stderr: '' },
  });
  await provider.runReview(INPUT);
  const { prompt } = invokeCall(calls);
  assert.match(prompt, /diff truncated at 200000 characters/);
  assert.ok(prompt.length < big.length);
  const row = assertOneDegradation(provider, /^x truncated at 200000/);
  assert.match(row.reason, new RegExp(`${big.length - 200_000} characters`));
});

test('a generated file is stubbed before the cap, so it cannot truncate the review', async () => {
  const generated = `diff --git a/gen/v.js b/gen/v.js\n+${'x'.repeat(250_000)}\n`;
  const { provider, calls } = harness({
    diff: { status: 0, stdout: `${DIFF}${generated}`, stderr: '' },
    attr: (args) => ({
      status: 0,
      stdout: args
        .slice(args.indexOf('--') + 1)
        .map(
          (p) =>
            `${p}\0linguist-generated\0${p === 'gen/v.js' ? 'true' : 'unspecified'}\0`,
        )
        .join(''),
      stderr: '',
    }),
  });
  await provider.runReview(INPUT);
  const { prompt } = invokeCall(calls);
  assert.doesNotMatch(prompt, /diff truncated/);
  assert.match(prompt, /gen\/v\.js\n\[generated file: changed/);
  assert.ok(prompt.includes(DIFF));
  assert.deepEqual(provider.getDegradations(), []);
});

test('runReview rejects a missing range or a bad ticket id', async () => {
  const { provider } = harness();
  await assert.rejects(
    () => provider.runReview({ ...INPUT, baseRef: '' }),
    TypeError,
  );
  await assert.rejects(
    () => provider.runReview({ ...INPUT, ticketId: 0 }),
    TypeError,
  );
});

test('the logger hears the invocation and a failed run', async () => {
  const lines = [];
  const logger = {
    info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]),
  };
  const { provider } = harness({ logger, status: 2, stdout: '', stderr: '' });
  await provider.runReview(INPUT);
  assertOneDegradation(provider, /status 2: <no output>/);
  assert.ok(lines.some(([lvl, m]) => lvl === 'info' && /--effort low/.test(m)));
  assert.ok(lines.some(([lvl, m]) => lvl === 'warn' && /status 2/.test(m)));
});

test('the claude call never blocks the event loop: a concurrent gate child drains while the reviewer runs (Story #5480)', async () => {
  const order = [];
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    gitSpawnFn: () => ({ status: 0, stdout: DIFF, stderr: '' }),
    authSpawnFn: () => ({ status: 0, stdout: AUTH_OK, stderr: '' }),
    // The real async runner, with a stand-in reviewer that reads the prompt
    // from stdin and answers after 600ms.
    spawnFn: (_file, _args, options) =>
      spawnCaptureAsync(
        process.execPath,
        [
          '-e',
          `process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(${JSON.stringify(envelope([]))}),600));`,
        ],
        // No shell: the stand-in's argv must reach node verbatim on Windows.
        { ...options, shell: false },
      ),
  });
  const review = provider.runReview(INPUT).then((findings) => {
    order.push('review');
    return findings;
  });
  // A gate child started after the reviewer, with more output than a pipe
  // buffer holds: it finishes only if its output drains meanwhile.
  const gate = spawnCaptureAsync(process.execPath, [
    '-e',
    "process.stdout.write('g'.repeat(512 * 1024))",
  ]).then((r) => {
    order.push('gate');
    return r.stdout.length;
  });
  const [findings, gateBytes] = await Promise.all([review, gate]);
  assert.deepEqual(findings, []);
  assert.deepEqual(provider.getDegradations(), []);
  assert.equal(gateBytes, 512 * 1024);
  assert.deepEqual(order, ['gate', 'review']);
});

const CALLER_DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1 +1 @@',
  '-export function loadWidget(id) {',
  '+export function loadWidget(id, opts) {',
].join('\n');
const CALLERS_SENTENCE =
  'The <callers> block lists lines outside the diff that reference symbols ' +
  'the diff changes; a caller the change breaks is a finding.';

test('#5764 AC-1: at deep the prompt carries a <callers> block from git grep at the head ref', async () => {
  const { provider, calls } = harness({
    diff: { status: 0, stdout: CALLER_DIFF, stderr: '' },
    grep: () => ({
      status: 0,
      stdout: 'story-5426:src/b.js:9:loadWidget(1);',
      stderr: '',
    }),
  });
  await provider.runReview({ ...INPUT, depth: 'deep' });
  const grep = calls.find((c) => c.kind === 'grep');
  assert.ok(grep.args.includes('story-5426'), 'greps the reviewed tip');
  assert.ok(grep.args.includes(':(exclude)src/a.js'));
  const { prompt } = invokeCall(calls);
  assert.ok(prompt.includes(CALLERS_SENTENCE));
  assert.match(
    prompt,
    /<callers>\n## loadWidget\nsrc\/b\.js:9: loadWidget\(1\);\n<\/callers>/,
  );
  assert.match(prompt, /Check every caller in the callers block/);
  assert.deepEqual(provider.getDegradations(), []);
});

for (const depth of ['light', 'standard']) {
  test(`#5764 AC-1: at ${depth} the prompt has no callers block and no grep runs`, async () => {
    const { provider, calls } = harness({
      diff: { status: 0, stdout: CALLER_DIFF, stderr: '' },
    });
    await provider.runReview({ ...INPUT, depth });
    assert.equal(calls.filter((c) => c.kind === 'grep').length, 0);
    const { prompt } = invokeCall(calls);
    assert.ok(!prompt.includes('<callers>'));
    assert.ok(!prompt.includes(CALLERS_SENTENCE));
  });
}

/** A per-file diff section of exactly `size` characters. */
function section(file, size) {
  const head = `diff --git a/${file} b/${file}\n+++ b/${file}\n`;
  return `${head}${'x'.repeat(size - head.length - 1)}\n`;
}

function invokeCalls(calls) {
  return calls
    .filter((c) => c.kind === 'invoke')
    .map((c) => ({ ...c, prompt: c.options.input }));
}

/** A spawnFn stub whose envelope is chosen per prompt. */
function perPromptHarness(diff, verdictFor, extra = {}) {
  const prompts = [];
  const wrapped = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    platform: 'linux',
    gitSpawnFn: (_cwd, ...args) =>
      args[0] === 'diff'
        ? { status: 0, stdout: diff, stderr: '' }
        : (extra.grep?.(args) ?? { status: 1, stdout: '', stderr: '' }),
    authSpawnFn: () => ({ status: 0, stdout: AUTH_OK, stderr: '' }),
    spawnFn: (_file, _args, options) => {
      prompts.push(options.input);
      return verdictFor(options.input);
    },
  });
  return { provider: wrapped, prompts };
}

const bug = (file, title = 'Bug') => ({
  title,
  body: 'b',
  file,
  line: 1,
  category: 'bug',
});

test('#5878 AC-1: a diff exactly at the cap is one reviewer invocation with no degradation', async () => {
  const diff = section('src/a.js', 200_000);
  const { provider, calls } = harness({
    diff: { status: 0, stdout: diff, stderr: '' },
  });
  await provider.runReview(INPUT);
  const invokes = invokeCalls(calls);
  assert.equal(invokes.length, 1);
  assert.ok(invokes[0].prompt.includes(`<diff>\n${diff}\n</diff>\n`));
  assert.deepEqual(provider.getDegradations(), []);
});

test('#5878 AC-2: a diff over the cap is reviewed in file-aligned chunks with merged, de-duplicated findings', async () => {
  const diff = [
    section('src/a.js', 120_000),
    section('src/b.js', 120_000),
    section('src/c.js', 60_000),
  ].join('');
  const { provider, prompts } = perPromptHarness(diff, (prompt) => ({
    status: 0,
    stdout: envelope(
      prompt.includes('+++ b/src/b.js')
        ? [bug('src/b.js'), bug('src/shared.js')]
        : [bug('src/a.js'), bug('src/shared.js')],
    ),
    stderr: '',
  }));
  const findings = await provider.runReview(INPUT);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    const body = prompt.slice(
      prompt.indexOf('<diff>\n') + 7,
      prompt.indexOf('\n</diff>'),
    );
    assert.ok(body.length <= 200_000, 'each chunk is at or under the cap');
    assert.ok(body.startsWith('diff --git '), 'chunks are file-aligned');
    assert.doesNotMatch(prompt, /diff truncated/);
  }
  assert.ok(
    prompts[0].includes('+++ b/src/a.js') &&
      prompts[0].includes('+++ b/src/c.js'),
  );
  assert.ok(prompts[1].includes('+++ b/src/b.js'));
  assert.deepEqual(findings.map((f) => f.file).sort(), [
    'src/a.js',
    'src/b.js',
    'src/shared.js',
  ]);
  assert.deepEqual(provider.getDegradations(), []);
});

test('#5878 AC-2: the callers block rides every chunk and comes out of the chunk budget', async () => {
  const caller = 'export function loadWidget() {}';
  const w = `diff --git a/src/w.js b/src/w.js\n+++ b/src/w.js\n@@ -1 +1 @@\n+${caller}\n`;
  // a + w + b is 10 characters under the cap: it fits only if callers is ignored.
  const diff = [
    section('src/a.js', 120_000),
    w,
    section('src/b.js', 80_000 - w.length - 10),
    section('src/c.js', 15_000),
  ].join('');
  const { provider, prompts } = perPromptHarness(
    diff,
    () => ({ status: 0, stdout: envelope([]), stderr: '' }),
    {
      grep: () => ({
        status: 0,
        stdout: 'story-5426:src/z.js:9:loadWidget(1);',
        stderr: '',
      }),
    },
  );
  await provider.runReview({ ...INPUT, depth: 'deep' });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes('+++ b/src/b.js'), 'b moved to chunk 2');
  for (const prompt of prompts) {
    assert.match(prompt, /<callers>\n## loadWidget\n/);
    const body = prompt.slice(
      prompt.indexOf('<diff>\n') + 7,
      prompt.indexOf('\n</diff>\n'),
    );
    const callers = prompt.slice(prompt.indexOf('\n</diff>\n') + 9);
    assert.ok(body.length + callers.length <= 200_000);
  }
  assert.deepEqual(provider.getDegradations(), []);
});

test('#5878 AC-3: files past the chunk bound are degraded by name', async () => {
  const files = Array.from({ length: 8 }, (_, i) => `src/f${i}.js`);
  const diff = files.map((f) => section(f, 150_000)).join('');
  const { provider, prompts } = perPromptHarness(diff, () => ({
    status: 0,
    stdout: envelope([]),
    stderr: '',
  }));
  await provider.runReview(INPUT);
  assert.equal(prompts.length, 6);
  const row = assertOneDegradation(provider, /review bounded at 6 chunks/);
  assert.match(
    row.reason,
    /2 file\(s\) not reviewed: src\/f6\.js, src\/f7\.js$/,
  );
});

test('#5878 AC-3: a chunk with no verdict is degraded naming its files while the other findings stand', async () => {
  const diff = [
    section('src/a.js', 150_000),
    section('src/b.js', 150_000),
  ].join('');
  const { provider } = perPromptHarness(diff, (prompt) =>
    prompt.includes('+++ b/src/a.js')
      ? { status: 0, stdout: 'not json', stderr: '' }
      : { status: 0, stdout: envelope([bug('src/b.js')]), stderr: '' },
  );
  const findings = await provider.runReview(INPUT);
  assert.deepEqual(
    findings.map((f) => f.file),
    ['src/b.js'],
  );
  assertOneDegradation(provider, /^no verdict for src\/a\.js: /);
});

test('#5764 AC-2: a capped callers block records one degradation naming the dropped symbols', async () => {
  const hits = Array.from(
    { length: 30 },
    (_, i) => `story-5426:src/b.js:${i + 1}:loadWidget();`,
  ).join('\n');
  const { provider } = harness({
    diff: { status: 0, stdout: CALLER_DIFF, stderr: '' },
    grep: () => ({ status: 0, stdout: hits, stderr: '' }),
  });
  await provider.runReview({ ...INPUT, depth: 'deep' });
  assertOneDegradation(
    provider,
    /callers block incomplete; not checked: loadWidget/,
  );
});
