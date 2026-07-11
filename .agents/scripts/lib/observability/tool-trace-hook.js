/**
 * Tool-trace hook (Epic #1030 Story #1043 / Task #1058).
 *
 * Entry point invoked from `.claude/settings.json` PreToolUse and
 * PostToolUse hook entries. Resolves the active Epic + Story from
 * environment variables (`CC_EPIC_ID` / `CC_STORY_ID`), pairs Pre/Post
 * tool-call events, and appends one `kind:"trace"` NDJSON line per tool
 * call to `temp/epic-<eid>/stories/story-<sid>/traces.ndjson` via the
 * `signals-writer.appendTrace` helper.
 *
 * Robustness contract (Tech Spec #1032 §observability + §security):
 *   - **No-op outside an active Story.** When `CC_EPIC_ID` or
 *     `CC_STORY_ID` is unset / non-numeric the hook returns immediately
 *     without touching the filesystem. This prevents tooling invoked
 *     during planning, dispatch, or close phases from polluting random
 *     NDJSON files.
 *   - **Best-effort.** The top-level `main(event)` is wrapped in
 *     `try/catch`. A failing hook MUST never block tool execution —
 *     `appendTrace` already swallows fs / serialisation failures, but
 *     the outer guard catches anything that might still escape (e.g. an
 *     event with a circular reference reachable before serialisation).
 *   - **Privacy-preserving detail.** Bash commands and file paths are
 *     hashed (sha256) before being recorded. We deliberately store
 *     `targetHash` rather than the raw value because a Bash command may
 *     embed an env-var-laden token and a file path may leak the
 *     operator's local layout. The hash gives the analyzer enough to
 *     count repeats (churn / retry detectors) without retaining the
 *     plaintext.
 *   - **Capped detail size.** Even after hashing, supplementary fields
 *     (durationMs, exit code summaries, etc.) are clamped to
 *     `MAX_DETAIL_BYTES` so a runaway tool argument can't bloat the
 *     trace file.
 *
 * Pre/Post pairing:
 *   - `PreToolUse` records the start timestamp keyed by the event's
 *     `tool_use_id` (provided by the harness) into a process-local
 *     `Map`. Pre events themselves do NOT append to `traces.ndjson` —
 *     only the matching Post event does, once it has a duration to
 *     attach.
 *   - `PostToolUse` looks up the start record, computes
 *     `durationMs = now - startedAt`, appends the trace line, and
 *     evicts the start record. A Post without a matching Pre still
 *     appends a single trace line (with `durationMs: null`) so the
 *     event is not silently dropped — this matches the AC: "PostToolUse
 *     without a matching PreToolUse logs once and returns without
 *     throwing".
 */

import { createHash } from 'node:crypto';

import { appendTrace } from './signals-writer.js';

/**
 * Maximum size (bytes) for any single string field stored in the trace
 * `details` payload after hashing. Hashes are 64 hex chars (always under
 * the cap); the limit guards supplementary plaintext fields that may
 * legitimately appear (e.g. tool name, phase, exit-code summaries).
 */
const MAX_DETAIL_BYTES = 1024;

/**
 * Process-local Map keyed by the harness-provided `tool_use_id` (or a
 * synthetic key when the harness omits it). Holds `{ startedAt, tool }`
 * for each in-flight tool call until the matching Post event lands.
 *
 * The Map lives at module scope on purpose: PreToolUse and PostToolUse
 * are invoked as separate hook calls within the same parent agent
 * process, so a module-level Map preserves state across calls without
 * any external coordination. If the agent process crashes mid-tool-
 * call, the Map dies with it and no orphan record leaks.
 */
const inflight = new Map();

/**
 * SHA-256 hex digest of the input string, prefixed with `sha256:` to
 * mirror the convention used elsewhere in the signals pipeline (see
 * `signal-event.schema.json` `details.targetHash`). Returns `null` for
 * empty / non-string input so callers can omit the field entirely
 * rather than recording a hash of the empty string.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function hashTarget(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Normalise a Bash command string into a stable identity for the retry
 * detector (Story #1768 / Task #1775). The output is what we hash to
 * derive `details.normalizedHash`; the raw value is still hashed
 * separately into `details.targetHash` so the privacy contract for the
 * raw command is unchanged.
 *
 * ## Rules (documented contract — kept narrow on purpose)
 *
 *   1. **Whitespace collapse.** Leading/trailing whitespace is stripped
 *      and runs of internal whitespace collapse to a single space.
 *      `npm  test` → `npm test`. `\n` and `\t` count as whitespace.
 *
 *   2. **Strip benign trailing flags.** `--no-color` and `--quiet`
 *      anywhere in the argv are removed (with their surrounding
 *      whitespace re-collapsed). These flags affect output only and
 *      never change the command's identity for retry-detection
 *      purposes. The list is deliberately tiny — adding more flags is
 *      a new ADR conversation, not a hook tweak.
 *
 *   3. **`npm test` ≡ `npm run test`.** Only this single paraphrase
 *      collapses. `npm run lint` and `npm test` do **not** collapse;
 *      `npm run build` and `npm build` do **not** collapse. The
 *      treatment is intentional: it covers the one paraphrase the
 *      `package.json` `scripts.test` shorthand makes idiomatic, and
 *      stops there.
 *
 * Returns `null` when the input is not a non-empty string (so the
 * caller can omit the field rather than recording a hash of `''`).
 *
 * Exported for testing — the unit suite asserts the collapse rules.
 *
 * @param {unknown} command
 * @returns {string|null}
 */
export function normaliseBashCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null;

  // Step 1: whitespace collapse. Trim then collapse internal runs.
  let normalised = command.trim().replace(/\s+/g, ' ');
  if (normalised.length === 0) return null;

  // Step 2: strip benign trailing/inline flags. Token-level removal so
  // we don't accidentally chew into a longer flag (e.g. `--quiet-mode`
  // would not match `--quiet`).
  const benignFlags = new Set(['--no-color', '--quiet']);
  const tokens = normalised.split(' ').filter((tok) => !benignFlags.has(tok));
  normalised = tokens.join(' ');
  if (normalised.length === 0) return null;

  // Step 3: collapse `npm run test` → `npm test`. Only this exact
  // paraphrase. We rewrite to the shorter form because the longer form
  // is more verbose; either direction would work, but the `scripts.test`
  // shorthand is the form most operators type.
  if (normalised === 'npm run test') {
    normalised = 'npm test';
  }

  return normalised;
}

/**
 * Clamp a string field so a misbehaving tool argument can't bloat the
 * trace file. Non-string input is returned unchanged (numbers, booleans,
 * etc. are size-bounded by JSON serialisation).
 */
function clamp(value) {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value, 'utf8') <= MAX_DETAIL_BYTES) return value;
  // Truncate by code units; exact byte cap not critical because the
  // limit exists for size protection, not for security.
  return `${value.slice(0, MAX_DETAIL_BYTES)}…`;
}

/**
 * Resolve the active Epic + Story from env vars. Returns `null` when
 * `CC_STORY_ID` is unset / non-numeric — the caller treats this as
 * the "outside an active Story, no-op" case.
 *
 * Story #2874 — `epicId` can be `null` for standalone Stories (run
 * via `/single-story-deliver`). When `CC_STORY_ID` is present but
 * `CC_EPIC_ID` is absent, the hook still emits trace lines, keyed
 * to the story only; the trace's `epicId` field is `null`. The
 * no-op contract for the fully-no-context case (both vars absent)
 * is preserved: it returns null.
 *
 * Exported for testing (the unit suite asserts that an unset
 * `CC_STORY_ID` makes the hook take the no-op branch, and that an
 * unset `CC_EPIC_ID` with a present `CC_STORY_ID` yields a
 * `{ epicId: null, storyId }` envelope).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ epicId: number|null, storyId: number }|null}
 */
export function resolveActiveStory(env = process.env) {
  const epicRaw = env.CC_EPIC_ID;
  const storyRaw = env.CC_STORY_ID;
  if (!storyRaw) return null;
  const storyId = Number.parseInt(storyRaw, 10);
  if (!Number.isInteger(storyId) || storyId <= 0) return null;
  if (!epicRaw) return { epicId: null, storyId };
  const epicId = Number.parseInt(epicRaw, 10);
  if (!Number.isInteger(epicId) || epicId <= 0) return null;
  return { epicId, storyId };
}

/**
 * Story #1768 / Task #1775 — extract the Bash-input hashing into a
 * helper so `buildDetails` stays under its CRAP baseline. Returns
 * `{ targetHash, normalizedHash? }` for Bash input, `null` for any
 * other shape so the caller can fall through to the file_path / pattern
 * branches unchanged. The `normalizedHash` is omitted when
 * `normaliseBashCommand` rejects the input (non-string / empty after
 * normalisation).
 *
 * @param {object} toolInput
 * @returns {{ targetHash: string, normalizedHash?: string } | null}
 */
function hashBashInput(toolInput) {
  if (typeof toolInput?.command !== 'string') return null;
  const out = { targetHash: hashTarget(toolInput.command) };
  const normalised = normaliseBashCommand(toolInput.command);
  if (normalised !== null) {
    out.normalizedHash = hashTarget(normalised);
  }
  return out;
}

/**
 * Build the canonical `details` block for a trace line. Hashes the
 * Bash command (`tool_input.command`) and any file-path-shaped input
 * (`tool_input.file_path`, `tool_input.path`, `tool_input.pattern`)
 * before recording. The raw value never appears on disk.
 *
 * @param {{ tool: string, toolInput?: object, durationMs?: number|null, exitCode?: number|null }} args
 * @returns {object}
 */
function buildDetails({ tool, toolInput, durationMs, exitCode }) {
  const details = {};
  if (typeof durationMs === 'number') {
    details.durationMs = durationMs;
  } else if (durationMs === null) {
    details.durationMs = null;
  }

  // Bash exit code — the retry detector's failure predicate
  // (`details.exitCode !== 0`) can only fire once this is recorded. Only
  // Bash PostToolUse events carry a meaningful exit code; other tools omit
  // the field entirely (Epic #4406 / Story #4413).
  if (tool === 'Bash' && typeof exitCode === 'number') {
    details.exitCode = exitCode;
  }

  if (toolInput && typeof toolInput === 'object') {
    // Bash: hash `command` so a token-laden string never lands on disk.
    // Story #1768 also records `normalizedHash` (paraphrase-collapsed)
    // for retry detection. See `hashBashInput`.
    const bash = hashBashInput(toolInput);
    if (bash) Object.assign(details, bash);
    // Edit / Write / Read: hash `file_path` for the same reason — the
    // operator's local path layout is not interesting to the analyzer.
    if (
      typeof toolInput.file_path === 'string' &&
      details.targetHash === undefined
    ) {
      details.targetHash = hashTarget(toolInput.file_path);
    }
    // Glob / Grep: pattern is not secret, but we hash for consistency
    // and so the `churn` detector can count repeats by hash equality.
    if (
      typeof toolInput.pattern === 'string' &&
      details.targetHash === undefined
    ) {
      details.targetHash = hashTarget(toolInput.pattern);
    }
    // Agent: record the literal `model` arg (Story #2590). The arg is a
    // short enum value ('haiku'/'sonnet'/'opus') with no operator-secret
    // content, so we store it plaintext. Records absence as `null` for
    // Agent calls only — the field is omitted for every other tool — so
    // the analyzer can distinguish "Agent fired without model" from
    // "non-Agent tool".
    if (tool === 'Agent') {
      details.model =
        typeof toolInput.model === 'string' ? clamp(toolInput.model) : null;
    }
  }

  // Clamp the tool name (defensive — Claude's tool names are short, but
  // a hostile harness could inject a long string and we'd rather cap
  // here than leak it onto disk).
  if (tool) details.tool = clamp(tool);

  return details;
}

/**
 * Extract the Bash exit code from a PostToolUse event. The harness reports
 * the tool result under `tool_response` (occasionally at the event root);
 * the exit-code field name is not contractually fixed across harness
 * versions, so we probe the known aliases and return the first numeric
 * hit. Returns `null` when no numeric exit code is present — the caller
 * omits `details.exitCode` entirely rather than recording a guess.
 *
 * Exported for testing.
 *
 * @param {object} event
 * @returns {number|null}
 */
export function extractExitCode(event) {
  const candidates = [
    event?.tool_response?.exitCode,
    event?.tool_response?.exit_code,
    event?.tool_response?.returnCode,
    event?.tool_response?.code,
    event?.tool_response?.status,
    event?.exit_code,
    event?.exitCode,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

/**
 * PreToolUse handler. Stashes `{ startedAt, tool }` into the in-flight
 * Map keyed by the harness `tool_use_id`. Does not append to
 * `traces.ndjson` — the matching Post event does that once it has a
 * duration to attach.
 *
 * Exported for testing.
 *
 * @param {object} event
 */
export function handlePre(event) {
  const id = event?.tool_use_id ?? event?.id ?? null;
  if (!id) return; // No id => no way to pair on Post; drop silently.
  const tool = event?.tool_name ?? event?.tool ?? null;
  inflight.set(id, { startedAt: Date.now(), tool });
}

/**
 * PostToolUse handler. Looks up the start record, computes a duration,
 * appends one `kind:"trace"` line to `traces.ndjson`, and evicts the
 * start record. A Post without a matching Pre still appends a single
 * line with `durationMs: null` (AC: "PostToolUse without a matching
 * PreToolUse logs once and returns without throwing").
 *
 * Exported for testing.
 *
 * @param {object} event
 * @param {{ epicId: number, storyId: number }} active
 */
export async function handlePost(event, active) {
  const id = event?.tool_use_id ?? event?.id ?? null;
  const tool = event?.tool_name ?? event?.tool ?? 'unknown';
  const toolInput = event?.tool_input;
  const exitCode = extractExitCode(event);

  let durationMs = null;
  if (id && inflight.has(id)) {
    const start = inflight.get(id);
    inflight.delete(id);
    durationMs = Date.now() - start.startedAt;
  }

  const trace = {
    ts: new Date().toISOString(),
    kind: 'trace',
    emitter: { tool: clamp(tool) },
    epicId: active.epicId,
    storyId: active.storyId,
    taskId: null,
    phase:
      typeof process.env.CC_PHASE === 'string' ? process.env.CC_PHASE : null,
    details: buildDetails({ tool, toolInput, durationMs, exitCode }),
  };

  await appendTrace({
    epicId: active.epicId,
    storyId: active.storyId,
    trace,
  });
}

/**
 * Top-level entry point. Routes by `event.hook_event_name` to the
 * Pre/Post handlers; swallows every error so tool execution is never
 * blocked.
 *
 * @param {object} event
 * @returns {Promise<void>}
 */
export async function main(event) {
  try {
    const active = resolveActiveStory();
    if (!active) return; // No active Story => zero filesystem calls.
    if (!event || typeof event !== 'object') return;

    const phase = event.hook_event_name;
    if (phase === 'PreToolUse') {
      handlePre(event);
    } else if (phase === 'PostToolUse') {
      await handlePost(event, active);
    }
    // Any other phase is silently ignored — the hook is registered for
    // Pre/Post only; receiving anything else is a configuration error
    // we should not amplify by throwing.
  } catch {
    // Swallow. Observability MUST NOT take down the runner.
    // signals-writer.appendTrace already logs its own failures via
    // Logger.warn; anything that escapes to here is a programmer
    // error in this module, not an operator-visible signal.
  }
}

/**
 * CLI entry point: read one JSON event from stdin, dispatch to `main`,
 * and exit 0 unconditionally. The harness pipes the hook payload as
 * stdin per the `.claude/settings.json` `type: "command"` contract.
 *
 * Exported so tests can run the file as a module without re-spawning
 * Node. Production callers go through the bin shim
 * (`node lib/observability/tool-trace-hook.js`) which immediately
 * delegates here.
 */
export async function runFromStdin() {
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
  } catch {
    return; // No stdin => nothing to do.
  }

  let event;
  try {
    event = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    return; // Malformed JSON => silent no-op (never block the tool).
  }
  if (!event) return;

  await main(event);
}

// Auto-run when invoked directly: `node tool-trace-hook.js`.
const isDirect = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return argv1.endsWith('tool-trace-hook.js');
  } catch {
    return false;
  }
})();
if (isDirect) {
  runFromStdin();
}

/**
 * Test-only: clear the in-flight Map. Module-level state survives
 * across tests within the same Node process; the unit suite calls this
 * from `beforeEach` to keep tests independent.
 */
export function _resetInflightForTests() {
  inflight.clear();
}
