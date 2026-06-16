// bench/driver/run-session.js
/**
 * Headless run driver for the Mandrel self-benchmark harness.
 *
 * A "run" is one headless Claude Code session driving one arm over one
 * scenario. The driver shells out to `claude -p --output-format json`, which
 * runs the agent non-interactively and emits a single JSON result envelope on
 * stdout carrying the real usage/cost actuals (`total_cost_usd`, `usage`,
 * `modelUsage`, timings). This is the ONLY cost source in the harness — Mandrel
 * itself records no token actuals — and it is measured identically for both
 * arms, so the value/cost comparison is apples-to-apples by construction
 * (Epic #4211, Tech Spec #4213).
 *
 * Precedent: `.agents/scripts/lib/orchestration/review-providers/security-review.js`
 * (`defaultInvokeSecurityReview`) already shells `claude --print` and parses
 * its stdout. This module follows the same shape — a default `spawnSync`-based
 * invoker that is **injectable** (`invokeFn`) so unit tests never spawn a real
 * process — but targets the `-p --output-format json` envelope rather than the
 * free-text `--print` mode.
 *
 * The driver does NOT score, persist, or read lifecycle telemetry — those are
 * downstream slices. It launches the session, parses the envelope, and returns
 * a normalized `{ usage, cost, raw, ... }` record plus the per-run prompt that
 * was sent.
 */

import { spawnSync } from 'node:child_process';

/**
 * Pinned default model id. The harness records the exact model on every
 * scorecard and only ever compares like-model to like-model (Epic Non-Goal:
 * "A model benchmark — the model is pinned and recorded"). Overridable per run.
 */
export const DEFAULT_BENCH_MODEL = 'claude-opus-4-8';

/**
 * Hard ceiling for a single headless session. Long agentic `/deliver` runs are
 * the expensive case; default to one hour and let callers override.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Compose the prompt sent to `claude -p` for a given arm + scenario.
 *
 * - **mandrel** arm: drive the real Mandrel pipeline (`/plan` then `/deliver`)
 *   so planning fidelity is genuinely measured rather than pre-staged
 *   (Epic Non-Goal: "Pre-staged plans … would grade our own homework").
 * - **control** arm: hand the bare task straight to the model with no
 *   scaffolding.
 *
 * The unattended-mode preamble (auto-proceed through HITL gates) is documented
 * in `bench/driver/unattended.md` and injected here so every Mandrel-arm run
 * carries it. Exported so docs tooling and tests reference one canonical
 * builder.
 *
 * @param {object} input
 * @param {'mandrel'|'control'} input.arm
 * @param {{ id: string, taskPrompt: string, epicId?: number|string }} input.scenario
 * @returns {string}
 */
export function buildArmPrompt(input) {
  const { arm, scenario } = input ?? {};
  if (!scenario || typeof scenario.id !== 'string') {
    throw new TypeError('buildArmPrompt requires a scenario with a string id');
  }
  if (
    typeof scenario.taskPrompt !== 'string' ||
    scenario.taskPrompt.length === 0
  ) {
    throw new TypeError('buildArmPrompt requires scenario.taskPrompt');
  }

  if (arm === 'control') {
    // Bare-model baseline: no Mandrel scaffolding, no pipeline ceremony.
    return (
      `You are working in a fresh git checkout. Complete the following task ` +
      `end to end, committing your work. Do not ask for confirmation — proceed ` +
      `autonomously to completion.\n\nTask (${scenario.id}):\n${scenario.taskPrompt}`
    );
  }

  if (arm === 'mandrel') {
    // Mandrel pipeline arm. Auto-proceed directive keeps the HITL STOP gates
    // from stalling the headless session (see unattended.md).
    return (
      `You are operating Mandrel's pipeline non-interactively under a headless ` +
      `benchmark driver. There is no human at the keyboard. At every ` +
      `human-in-the-loop STOP / confirmation gate (one-pager confirm, spec ` +
      `review, decomposition diff gate, and the auto-merge-else-operator-merge ` +
      `step), treat the absence of an operator as implicit approval and proceed ` +
      `with the best available interpretation — never block waiting for input. ` +
      `Author the plan with /plan and then deliver it with /deliver; do not ` +
      `pre-stage any planning artifact.\n\nTask (${scenario.id}):\n${scenario.taskPrompt}`
    );
  }

  throw new TypeError(
    `buildArmPrompt arm must be "mandrel" or "control", got: ${String(arm)}`,
  );
}

/**
 * Build the argv passed to the `claude` binary for a headless JSON run.
 * Exported so tests assert the exact invocation shape (notably
 * `--output-format json`, which is what makes the usage/cost envelope appear).
 *
 * `--permission-mode bypassPermissions` and `--dangerously-skip-permissions`
 * are intentionally NOT added here by default — the harness runs inside a
 * throwaway sandbox clone (see `sandbox.js`); callers that need a broader
 * autorun posture pass `extraArgs`. We keep the default surface minimal.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {string} input.model
 * @param {string[]} [input.extraArgs]
 * @returns {string[]}
 */
export function buildClaudeArgs(input) {
  const { prompt, model, extraArgs = [] } = input ?? {};
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new TypeError('buildClaudeArgs requires a non-empty prompt');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('buildClaudeArgs requires a non-empty model');
  }
  if (!Array.isArray(extraArgs)) {
    throw new TypeError('buildClaudeArgs extraArgs must be an array');
  }
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    ...extraArgs,
    prompt,
  ];
}

/**
 * Default invoker: shell out to the host's `claude` CLI in headless JSON mode.
 * Exported and injectable — the production caller accepts an `invokeFn`
 * override so tests never spawn a real process.
 *
 * Mirrors `defaultInvokeSecurityReview`'s contract: returns
 * `{ status, stdout, stderr }`. The `cwd` is the ephemeral sandbox clone, so
 * all churn lands there and never in the live repo.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {string} input.model
 * @param {string} input.cwd       Absolute path of the sandbox clone to run in.
 * @param {string[]} [input.extraArgs]
 * @param {number} [input.timeoutMs]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function defaultInvokeClaudeSession(input) {
  const { prompt, model, cwd, extraArgs, timeoutMs } = input ?? {};
  const args = buildClaudeArgs({ prompt, model, extraArgs });
  const result = spawnSync('claude', args, {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Parse the `claude -p --output-format json` envelope into the fields the
 * harness needs. The envelope is a single JSON object on stdout; we tolerate
 * leading/trailing whitespace and a possible prose preface by extracting the
 * first balanced top-level object.
 *
 * Verified against a live run on `claude` 2.1.178: the envelope carries
 * `type:"result"`, `subtype`, `is_error`, `result`, `total_cost_usd`,
 * `usage:{ input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, ... }`, `modelUsage`, `duration_ms`, `num_turns`,
 * `session_id`, `permission_denials`, and `terminal_reason`.
 *
 * Exported for testing.
 *
 * @param {string} rawStdout
 * @returns {{
 *   type: string|undefined,
 *   subtype: string|undefined,
 *   isError: boolean,
 *   result: string|undefined,
 *   sessionId: string|undefined,
 *   numTurns: number|undefined,
 *   durationMs: number|undefined,
 *   cost: { totalUsd: number|null },
 *   usage: {
 *     inputTokens: number,
 *     outputTokens: number,
 *     cacheCreationInputTokens: number,
 *     cacheReadInputTokens: number,
 *     totalTokens: number
 *   },
 *   modelUsage: Record<string, unknown>,
 *   permissionDenials: unknown[],
 *   terminalReason: string|undefined,
 *   raw: object
 * }}
 * @throws {Error} when stdout contains no parseable JSON object.
 */
export function parseSessionEnvelope(rawStdout) {
  const obj = extractFirstJsonObject(rawStdout);
  if (obj === null) {
    throw new Error(
      '[run-session] Failed to parse claude --output-format json stdout as a JSON object.',
    );
  }

  const usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
  const inputTokens = toNonNegInt(usage.input_tokens);
  const outputTokens = toNonNegInt(usage.output_tokens);
  const cacheCreationInputTokens = toNonNegInt(
    usage.cache_creation_input_tokens,
  );
  const cacheReadInputTokens = toNonNegInt(usage.cache_read_input_tokens);

  const totalCost =
    typeof obj.total_cost_usd === 'number' &&
    Number.isFinite(obj.total_cost_usd)
      ? obj.total_cost_usd
      : null;

  return {
    type: typeof obj.type === 'string' ? obj.type : undefined,
    subtype: typeof obj.subtype === 'string' ? obj.subtype : undefined,
    isError: obj.is_error === true,
    result: typeof obj.result === 'string' ? obj.result : undefined,
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
    numTurns: Number.isFinite(obj.num_turns) ? obj.num_turns : undefined,
    durationMs: Number.isFinite(obj.duration_ms) ? obj.duration_ms : undefined,
    cost: { totalUsd: totalCost },
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens:
        inputTokens +
        outputTokens +
        cacheCreationInputTokens +
        cacheReadInputTokens,
    },
    modelUsage:
      obj.modelUsage && typeof obj.modelUsage === 'object'
        ? obj.modelUsage
        : {},
    permissionDenials: Array.isArray(obj.permission_denials)
      ? obj.permission_denials
      : [],
    terminalReason:
      typeof obj.terminal_reason === 'string' ? obj.terminal_reason : undefined,
    raw: obj,
  };
}

/**
 * Launch a headless `claude -p --output-format json` session for one arm and
 * scenario and return the parsed usage/cost envelope.
 *
 * @param {object} opts
 * @param {'mandrel'|'control'} opts.arm
 * @param {{ id: string, taskPrompt: string, epicId?: number|string }} opts.scenario
 * @param {string} opts.cwd  Absolute path of the ephemeral sandbox clone.
 * @param {string} [opts.model=DEFAULT_BENCH_MODEL]
 * @param {string[]} [opts.extraArgs]
 * @param {number} [opts.timeoutMs=DEFAULT_SESSION_TIMEOUT_MS]
 * @param {object} [deps]
 * @param {(input: object) => { status: number, stdout: string, stderr: string }} [deps.invokeFn]
 *   Injected session invoker. Defaults to `defaultInvokeClaudeSession`. Tests
 *   override this so no real `claude` process is spawned.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @returns {{
 *   arm: 'mandrel'|'control',
 *   scenarioId: string,
 *   model: string,
 *   prompt: string,
 *   status: number,
 *   envelope: ReturnType<typeof parseSessionEnvelope>
 * }}
 */
export function runSession(opts = {}, deps = {}) {
  const {
    arm,
    scenario,
    cwd,
    model = DEFAULT_BENCH_MODEL,
    extraArgs = [],
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = opts;

  if (arm !== 'mandrel' && arm !== 'control') {
    throw new TypeError(
      `runSession arm must be "mandrel" or "control", got: ${String(arm)}`,
    );
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError(
      'runSession requires a non-empty cwd (sandbox clone path)',
    );
  }

  const invokeFn = deps.invokeFn ?? defaultInvokeClaudeSession;
  const logger = deps.logger;

  const prompt = buildArmPrompt({ arm, scenario });

  logger?.info?.(
    `[run-session] Launching headless session: arm=${arm} scenario=${scenario.id} model=${model}`,
  );

  const { status, stdout, stderr } = invokeFn({
    prompt,
    model,
    cwd,
    extraArgs,
    timeoutMs,
  });

  if (status !== 0) {
    throw new Error(
      `[run-session] claude -p exited with status ${status} ` +
        `(arm=${arm}, scenario=${scenario.id}): ${
          stderr || stdout || '<no output>'
        }`,
    );
  }

  const envelope = parseSessionEnvelope(stdout);

  // A clean exit code with an error envelope is still a failed run — surface it
  // rather than silently returning a zero-cost record the scorer would trust.
  if (envelope.isError) {
    logger?.warn?.(
      `[run-session] Session reported is_error=true (arm=${arm}, scenario=${scenario.id}): ${
        envelope.result ?? '<no result text>'
      }`,
    );
  }

  logger?.info?.(
    `[run-session] Session complete: arm=${arm} scenario=${scenario.id} ` +
      `cost=$${envelope.cost.totalUsd ?? '?'} tokens=${envelope.usage.totalTokens} turns=${
        envelope.numTurns ?? '?'
      }`,
  );

  return {
    arm,
    scenarioId: scenario.id,
    model,
    prompt,
    status,
    envelope,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a value to a non-negative integer, defaulting to 0. Token-count
 * fields in the envelope are always non-negative integers; a missing or
 * malformed field collapses to 0 rather than NaN so downstream sums stay valid.
 *
 * @param {unknown} v
 * @returns {number}
 */
function toNonNegInt(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return Math.trunc(v);
  }
  return 0;
}

/**
 * Extract the first balanced top-level JSON object from a string, tolerating a
 * prose preface or trailing text around it. Returns the parsed object, or
 * `null` when no parseable object is present.
 *
 * Brace-counting is done outside string literals (with escape handling) so a
 * `}` inside a JSON string value does not prematurely close the scan.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function extractFirstJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Fast path: the whole stdout is one JSON object.
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct;
    }
  } catch {
    // Fall through to the scanning path.
  }

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
}
