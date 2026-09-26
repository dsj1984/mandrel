/**
 * Unit tests for `review-providers/code-review.js` — Story #5426.
 *
 * Every test injects the probe, git and `claude` spawn seams: none spawns
 * the real `claude` binary.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSurvivingCritical } from '../../../../.agents/scripts/lib/audit-suite/findings.js';
import { spawnCaptureAsync } from '../../../../.agents/scripts/lib/child-exec.js';
import { createCodeReviewProviderForRegistry } from '../../../../.agents/scripts/lib/orchestration/review-providers/code-review.js';

const INPUT = Object.freeze({
  scope: 'story',
  ticketId: 5426,
  baseRef: 'origin/main',
  headRef: 'story-5426',
  depth: 'standard',
  labels: ['type::story'],
});

const DIFF = 'diff --git a/src/a.js b/src/a.js\n+const x = 1;\n';

/**
 * @param {{ stdout?: string, status?: number, stderr?: string, diff?: object }} [opts]
 */
function harness(opts = {}) {
  const calls = [];
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    gitSpawnFn: (cwd, ...args) => {
      calls.push({ kind: 'diff', cwd, args });
      return opts.diff ?? { status: 0, stdout: DIFF, stderr: '' };
    },
    spawnFn: (file, args, options) => {
      calls.push({ kind: 'invoke', file, args: [...args], options });
      return {
        status: opts.status ?? 0,
        stdout: opts.stdout ?? '[]',
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

test('construction throws when the claude CLI probe reports absent', () => {
  assert.throws(
    () => createCodeReviewProviderForRegistry({ probeFn: () => false }),
    /"code-review" requires the `claude` CLI/,
  );
});

test('invokes claude --print --effort low with the diff range and Story id', async () => {
  const { provider, calls } = harness();
  await provider.runReview(INPUT);
  const call = invokeCall(calls);
  assert.equal(call.file, 'claude');
  assert.deepEqual(call.args, ['--print', '--effort', 'low']);
  assert.ok(call.options.timeout > 0, 'bounded timeout');
  const diffCall = calls.find((c) => c.kind === 'diff');
  assert.deepEqual(diffCall.args, [
    'diff',
    '--no-color',
    'origin/main...story-5426',
  ]);
  assert.ok(!call.args.includes('--model'), 'no model pin');
  assert.match(call.prompt, /origin\/main\.\.\.story-5426/);
  assert.match(call.prompt, /Story #5426/);
  assert.ok(call.prompt.includes(DIFF), 'diff text is handed over');
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
  assert.match(prompt, /Emit \[\] if there is nothing/);
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

test('every parsed finding is critical, so the chain halts', async () => {
  const stdout = JSON.stringify([
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
  assert.equal(findings[0].file, 'src/a.js');
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].category, 'bug');
  assert.equal(hasSurvivingCritical(countSeverity(findings)), true);
});

test('a fenced JSON array still parses', async () => {
  const stdout = '```json\n[{"title":"t","body":"b"}]\n```\n';
  const { provider } = harness({ stdout });
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
});

test('an empty array lets close proceed', async () => {
  const { provider } = harness({ stdout: '[]' });
  const findings = await provider.runReview(INPUT);
  assert.deepEqual(findings, []);
  assert.equal(hasSurvivingCritical(countSeverity(findings)), false);
});

test('unparseable output yields exactly one non-halting suggestion', async () => {
  const { provider } = harness({ stdout: 'Looks good to me!' });
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'suggestion');
  assert.match(findings[0].title, /not parseable/);
  assert.equal(hasSurvivingCritical(countSeverity(findings)), false);
});

test('a non-zero claude exit degrades to one non-halting suggestion', async () => {
  const { provider } = harness({ status: 1, stderr: 'rate limited' });
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'suggestion');
  assert.match(findings[0].body, /rate limited/);
});

test('an unreadable diff degrades to one suggestion without invoking claude', async () => {
  const { provider, calls } = harness({
    diff: { status: 128, stdout: '', stderr: 'bad revision' },
  });
  const findings = await provider.runReview(INPUT);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'suggestion');
  assert.match(findings[0].body, /bad revision/);
  assert.equal(invokeCall(calls), undefined);
});

test('an empty diff returns no findings without invoking claude', async () => {
  const { provider, calls } = harness({
    diff: { status: 0, stdout: '\n', stderr: '' },
  });
  assert.deepEqual(await provider.runReview(INPUT), []);
  assert.equal(invokeCall(calls), undefined);
});

test('an oversized diff is truncated and the reviewer is told', async () => {
  const big = `diff --git a/x b/x\n${'+'.repeat(250_000)}\n`;
  const { provider, calls } = harness({
    diff: { status: 0, stdout: big, stderr: '' },
  });
  await provider.runReview(INPUT);
  const { prompt } = invokeCall(calls);
  assert.match(prompt, /diff truncated at 200000 characters/);
  assert.ok(prompt.length < big.length);
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
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    gitSpawnFn: () => ({ status: 0, stdout: DIFF, stderr: '' }),
    spawnFn: () => ({ status: 2, stdout: '', stderr: '' }),
    logger,
  });
  const findings = await provider.runReview(INPUT);
  assert.match(findings[0].body, /<no output>/);
  assert.ok(lines.some(([lvl, m]) => lvl === 'info' && /--effort low/.test(m)));
  assert.ok(lines.some(([lvl, m]) => lvl === 'warn' && /exited 2/.test(m)));
});

test('the claude call never blocks the event loop: a concurrent gate child drains while the reviewer runs (Story #5480)', async () => {
  const order = [];
  const provider = createCodeReviewProviderForRegistry({
    probeFn: () => true,
    gitSpawnFn: () => ({ status: 0, stdout: DIFF, stderr: '' }),
    // The real async runner, with a stand-in reviewer that reads the prompt
    // from stdin and answers after 600ms.
    spawnFn: (_file, _args, options) =>
      spawnCaptureAsync(
        process.execPath,
        [
          '-e',
          "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.stdout.write('[]'),600));",
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
  assert.equal(gateBytes, 512 * 1024);
  assert.deepEqual(order, ['gate', 'review']);
});
