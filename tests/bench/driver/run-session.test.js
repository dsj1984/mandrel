// tests/bench/driver/run-session.test.js
/**
 * Unit tests for bench/driver/run-session.js — Story #4216.
 *
 * Verifies the headless `claude -p --output-format json` launcher:
 *   - builds the correct argv (including `--output-format json`),
 *   - composes distinct Mandrel-arm vs control-arm prompts,
 *   - parses the real session envelope into usage/cost,
 *   - drives entirely through an INJECTED invoke function (no real process),
 *   - surfaces a non-zero exit and unparseable stdout as errors.
 *
 * The envelope fixture below is a verbatim shape captured from a live
 * `claude 2.1.178 -p --output-format json` run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArmPrompt,
  buildClaudeArgs,
  DEFAULT_BENCH_MODEL,
  parseSessionEnvelope,
  runSession,
} from '../../../bench/driver/run-session.js';

const SCENARIO = {
  id: 'hello-world',
  taskPrompt: 'Create a hello-world HTTP server with a GET / route.',
};

/** A real-shape `claude -p --output-format json` envelope (trimmed). */
function realEnvelope(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4952,
    num_turns: 1,
    result: 'ok',
    session_id: '56d0b069-56c7-4d2b-bf76-b0cc4c5b388a',
    total_cost_usd: 0.346588,
    usage: {
      input_tokens: 4942,
      cache_creation_input_tokens: 31340,
      cache_read_input_tokens: 15626,
      output_tokens: 4,
      service_tier: 'standard',
    },
    modelUsage: {
      'claude-opus-4-8[1m]': { inputTokens: 4942, costUSD: 0.346023 },
    },
    permission_denials: [],
    terminal_reason: 'completed',
    uuid: '9d7dd296-f5c4-4156-9b50-f0cb4c0d053a',
    ...overrides,
  };
}

/**
 * Build an injected invoke that records its input and returns a fixed result.
 * @param {{ status?: number, stdout?: string, stderr?: string }} result
 */
function fakeInvoke(result = {}) {
  const calls = [];
  const fn = (input) => {
    calls.push(input);
    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? JSON.stringify(realEnvelope()),
      stderr: result.stderr ?? '',
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// buildClaudeArgs
// ---------------------------------------------------------------------------

test('buildClaudeArgs: emits -p and --output-format json with the model', () => {
  const args = buildClaudeArgs({
    prompt: 'do the thing',
    model: 'claude-opus-4-8',
  });
  assert.deepEqual(args, [
    '-p',
    '--output-format',
    'json',
    '--model',
    'claude-opus-4-8',
    'do the thing',
  ]);
});

test('buildClaudeArgs: places the prompt last, after extraArgs', () => {
  const args = buildClaudeArgs({
    prompt: 'PROMPT',
    model: 'm',
    extraArgs: ['--yes', '--permission-mode', 'bypassPermissions'],
  });
  assert.equal(args[args.length - 1], 'PROMPT');
  assert.ok(args.includes('--yes'));
  // --output-format json is non-negotiable: it is what surfaces the envelope.
  assert.equal(args[1], '--output-format');
  assert.equal(args[2], 'json');
});

test('buildClaudeArgs: rejects empty prompt / model / non-array extraArgs', () => {
  assert.throws(
    () => buildClaudeArgs({ prompt: '', model: 'm' }),
    /non-empty prompt/,
  );
  assert.throws(
    () => buildClaudeArgs({ prompt: 'p', model: '' }),
    /non-empty model/,
  );
  assert.throws(
    () => buildClaudeArgs({ prompt: 'p', model: 'm', extraArgs: 'nope' }),
    /extraArgs must be an array/,
  );
});

// ---------------------------------------------------------------------------
// buildArmPrompt
// ---------------------------------------------------------------------------

test('buildArmPrompt: mandrel arm drives /plan then /deliver with auto-proceed', () => {
  const prompt = buildArmPrompt({ arm: 'mandrel', scenario: SCENARIO });
  assert.match(prompt, /\/plan/);
  assert.match(prompt, /\/deliver/);
  assert.match(prompt, /headless/i);
  assert.match(prompt, /implicit approval|never block/i);
  assert.match(prompt, /hello-world/);
});

test('buildArmPrompt: control arm is bare — no Mandrel pipeline', () => {
  const prompt = buildArmPrompt({ arm: 'control', scenario: SCENARIO });
  assert.doesNotMatch(prompt, /\/plan|\/deliver/);
  assert.match(prompt, /autonomously/i);
  assert.match(prompt, /hello-world/);
});

test('buildArmPrompt: rejects bad arm and missing scenario fields', () => {
  assert.throws(
    () => buildArmPrompt({ arm: 'nope', scenario: SCENARIO }),
    /must be "mandrel" or "control"/,
  );
  assert.throws(
    () => buildArmPrompt({ arm: 'mandrel', scenario: {} }),
    /string id/,
  );
  assert.throws(
    () => buildArmPrompt({ arm: 'mandrel', scenario: { id: 'x' } }),
    /taskPrompt/,
  );
});

// ---------------------------------------------------------------------------
// parseSessionEnvelope
// ---------------------------------------------------------------------------

test('parseSessionEnvelope: extracts usage + cost from the real envelope', () => {
  const parsed = parseSessionEnvelope(JSON.stringify(realEnvelope()));
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.subtype, 'success');
  assert.equal(parsed.isError, false);
  assert.equal(parsed.result, 'ok');
  assert.equal(parsed.sessionId, '56d0b069-56c7-4d2b-bf76-b0cc4c5b388a');
  assert.equal(parsed.numTurns, 1);
  assert.equal(parsed.durationMs, 4952);
  assert.equal(parsed.cost.totalUsd, 0.346588);
  assert.equal(parsed.usage.inputTokens, 4942);
  assert.equal(parsed.usage.outputTokens, 4);
  assert.equal(parsed.usage.cacheCreationInputTokens, 31340);
  assert.equal(parsed.usage.cacheReadInputTokens, 15626);
  assert.equal(parsed.usage.totalTokens, 4942 + 4 + 31340 + 15626);
  assert.equal(parsed.terminalReason, 'completed');
  assert.deepEqual(parsed.permissionDenials, []);
  assert.equal(parsed.raw.uuid, '9d7dd296-f5c4-4156-9b50-f0cb4c0d053a');
});

test('parseSessionEnvelope: missing/malformed usage fields collapse to 0', () => {
  const parsed = parseSessionEnvelope(
    JSON.stringify({
      type: 'result',
      is_error: false,
      usage: { input_tokens: 'x' },
    }),
  );
  assert.equal(parsed.usage.inputTokens, 0);
  assert.equal(parsed.usage.outputTokens, 0);
  assert.equal(parsed.usage.totalTokens, 0);
  assert.equal(parsed.cost.totalUsd, null);
});

test('parseSessionEnvelope: tolerates a prose preface around the JSON', () => {
  const noisy = `Some banner line\n${JSON.stringify(realEnvelope())}\ntrailing note`;
  const parsed = parseSessionEnvelope(noisy);
  assert.equal(parsed.cost.totalUsd, 0.346588);
  assert.equal(parsed.usage.inputTokens, 4942);
});

test('parseSessionEnvelope: a brace inside a string value does not close the scan', () => {
  const env = realEnvelope({ result: 'done }{ ok' });
  const parsed = parseSessionEnvelope(`prefix ${JSON.stringify(env)}`);
  assert.equal(parsed.result, 'done }{ ok');
  assert.equal(parsed.cost.totalUsd, 0.346588);
});

test('parseSessionEnvelope: throws on non-JSON stdout', () => {
  assert.throws(
    () => parseSessionEnvelope('not json at all'),
    /Failed to parse/,
  );
  assert.throws(() => parseSessionEnvelope(''), /Failed to parse/);
});

// ---------------------------------------------------------------------------
// runSession (injected invoke — NEVER spawns a real process)
// ---------------------------------------------------------------------------

test('runSession: drives the injected invokeFn and returns the parsed envelope', () => {
  const invoke = fakeInvoke();
  const out = runSession(
    { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/sandbox-xyz' },
    { invokeFn: invoke },
  );

  assert.equal(invoke.calls.length, 1);
  assert.equal(invoke.calls[0].cwd, '/tmp/sandbox-xyz');
  assert.equal(invoke.calls[0].model, DEFAULT_BENCH_MODEL);
  assert.match(invoke.calls[0].prompt, /\/deliver/);

  assert.equal(out.arm, 'mandrel');
  assert.equal(out.scenarioId, 'hello-world');
  assert.equal(out.model, DEFAULT_BENCH_MODEL);
  assert.equal(out.status, 0);
  assert.equal(out.envelope.cost.totalUsd, 0.346588);
  assert.equal(out.envelope.usage.totalTokens, 4942 + 4 + 31340 + 15626);
});

test('runSession: forwards model, extraArgs, and timeoutMs to the invoker', () => {
  const invoke = fakeInvoke();
  runSession(
    {
      arm: 'control',
      scenario: SCENARIO,
      cwd: '/tmp/s',
      model: 'claude-sonnet-4-6',
      extraArgs: ['--yes'],
      timeoutMs: 123,
    },
    { invokeFn: invoke },
  );
  const call = invoke.calls[0];
  assert.equal(call.model, 'claude-sonnet-4-6');
  assert.deepEqual(call.extraArgs, ['--yes']);
  assert.equal(call.timeoutMs, 123);
  // control arm prompt must not carry pipeline commands
  assert.doesNotMatch(call.prompt, /\/plan|\/deliver/);
});

test('runSession: non-zero exit throws with stderr context', () => {
  const invoke = fakeInvoke({ status: 137, stderr: 'killed: timeout' });
  assert.throws(
    () =>
      runSession(
        { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/s' },
        { invokeFn: invoke },
      ),
    /exited with status 137.*killed: timeout/s,
  );
});

test('runSession: clean exit + is_error envelope warns but still returns the record', () => {
  const warnings = [];
  const invoke = fakeInvoke({
    status: 0,
    stdout: JSON.stringify(
      realEnvelope({
        is_error: true,
        subtype: 'error_during_execution',
        result: 'boom',
      }),
    ),
  });
  const out = runSession(
    { arm: 'mandrel', scenario: SCENARIO, cwd: '/tmp/s' },
    { invokeFn: invoke, logger: { warn: (m) => warnings.push(m), info() {} } },
  );
  assert.equal(out.envelope.isError, true);
  assert.equal(out.envelope.result, 'boom');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /is_error=true/);
});

test('runSession: rejects bad arm and empty cwd', () => {
  assert.throws(
    () => runSession({ arm: 'nope', scenario: SCENARIO, cwd: '/tmp/s' }, {}),
    /must be "mandrel" or "control"/,
  );
  assert.throws(
    () => runSession({ arm: 'mandrel', scenario: SCENARIO, cwd: '' }, {}),
    /non-empty cwd/,
  );
});

test('runSession: throws when the injected invoke returns unparseable stdout', () => {
  const invoke = fakeInvoke({ status: 0, stdout: 'totally not json' });
  assert.throws(
    () =>
      runSession(
        { arm: 'control', scenario: SCENARIO, cwd: '/tmp/s' },
        { invokeFn: invoke },
      ),
    /Failed to parse/,
  );
});
