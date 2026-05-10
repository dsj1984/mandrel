/**
 * sub-agent-return.js — parse and reconcile per-Story sub-agent return text.
 *
 * `/epic-deliver` Step 2 dispatches one `Agent` tool call per Story per
 * wave. Each sub-agent owes its parent the JSON return contract documented
 * in `.agents/workflows/epic-deliver.md`:
 *
 *   {
 *     "storyId": <number>,
 *     "status": "done" | "blocked" | "failed",
 *     "phase": "init|implementing|closing|blocked|done",
 *     "tasksDone": <number>,
 *     "tasksTotal": <number>,
 *     "branchDeleted": <boolean>,
 *     "blockerCommentId": <string|null>,
 *     "detail": <string|undefined>,
 *     "renderedBody": <string|undefined>
 *   }
 *
 * In practice, sub-agents sometimes return plain prose mid-task (Domio Epic
 * #604, 2026-05-04: a child returned `"Clean. Now commit Task 622."` after
 * 32 tool calls of real work). Without validation, the wave dispatcher
 * used to silently propagate the fragment and report the wave `complete`.
 *
 * This module provides the two helpers `/epic-deliver`'s wave dispatcher
 * now uses:
 *
 *   - `parseStoryAgentReturn(raw)` — accept an already-parsed object, a JSON
 *     string, or a fenced ```json ...``` block. Returns
 *     `{ ok: true, value }` on success, `{ ok: false, error }` otherwise.
 *
 *   - `reconcileStoryFromGitHub({ provider, storyId })` — reads the Story
 *     ticket's labels and `story-run-progress` structured comment to derive
 *     an authoritative result row. Used as a fallback whenever the
 *     sub-agent's return text fails to parse. Status is downgraded to
 *     `failed` unless the live ticket actually carries `agent::done`
 *     (in which case the operator may have manually closed the Story).
 */

import { parseFencedJsonComment } from '../structured-comment-parser.js';
import { findStructuredComment } from '../ticketing.js';
import { STORY_RUN_PROGRESS_TYPE } from './story-run-progress-writer.js';

const VALID_STATUS = new Set(['done', 'blocked', 'failed']);

/**
 * Best-effort extraction of a JSON object from a free-form sub-agent
 * return. Accepts (in order):
 *   1. an object that already looks parsed,
 *   2. a string starting with `{` that JSON-parses cleanly,
 *   3. a string containing a fenced ```json ...``` block,
 *   4. a string containing the first balanced `{...}` substring that
 *      JSON-parses (covers cases where the sub-agent prepended chat
 *      narration to an otherwise-valid envelope).
 *
 * The extraction is intentionally generous on the input side and strict on
 * the output side: callers always get a fully-validated object or `ok:
 * false`. Free-text sentences ("Clean. Now commit Task 622.") fall through
 * to `ok: false` and the caller MUST reconcile from GitHub.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseStoryAgentReturn(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return validateStoryReturnShape(raw);
  }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: `expected string or object, got ${raw === null ? 'null' : typeof raw}`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty return text' };
  }

  const candidates = collectJsonCandidates(trimmed);
  let firstValidationError = null;
  let anyParsed = false;
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      anyParsed = true;
      const validated = validateStoryReturnShape(parsed);
      if (validated.ok) return validated;
      if (!firstValidationError) firstValidationError = validated.error;
    }
  }
  if (anyParsed && firstValidationError) {
    return { ok: false, error: firstValidationError };
  }
  return {
    ok: false,
    error: `no parseable JSON envelope found in return text (${quote(trimmed)})`,
  };
}

/**
 * Validate the per-Story return contract. Pure helper — no IO.
 *
 * @param {object} obj
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateStoryReturnShape(obj) {
  const storyId = Number(obj.storyId ?? obj.id);
  if (!Number.isInteger(storyId) || storyId <= 0) {
    return {
      ok: false,
      error: `storyId must be a positive integer; got ${JSON.stringify(obj.storyId ?? obj.id)}`,
    };
  }
  const status = String(obj.status ?? '');
  if (!VALID_STATUS.has(status)) {
    return {
      ok: false,
      error: `status "${status}" must be one of: ${[...VALID_STATUS].join(', ')}`,
    };
  }
  const value = { storyId, status };
  if (typeof obj.phase === 'string') value.phase = obj.phase;
  if (Number.isInteger(obj.tasksDone)) value.tasksDone = obj.tasksDone;
  if (Number.isInteger(obj.tasksTotal)) value.tasksTotal = obj.tasksTotal;
  if (typeof obj.branchDeleted === 'boolean') {
    value.branchDeleted = obj.branchDeleted;
  }
  if (obj.blockerCommentId != null) {
    value.blockerCommentId = String(obj.blockerCommentId);
  }
  if (typeof obj.detail === 'string') value.detail = obj.detail;
  if (typeof obj.renderedBody === 'string')
    value.renderedBody = obj.renderedBody;
  return { ok: true, value };
}

/**
 * Heuristic candidate extraction. Returns string candidates (in priority
 * order) that the parser will try to JSON.parse. Pure helper — exposed for
 * tests but intentionally not part of the public API.
 *
 * @param {string} text
 * @returns {string[]}
 */
function collectJsonCandidates(text) {
  const out = [];
  if (text.startsWith('{')) out.push(text);

  const fenceMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) out.push(fenceMatch[1]);

  // First balanced `{...}` substring — naive but adequate for the chat
  // narration + envelope case.
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

function quote(text) {
  const oneline = text.replace(/\s+/g, ' ').trim();
  return oneline.length > 120 ? `${oneline.slice(0, 117)}...` : oneline;
}

/**
 * Authoritative reconciliation: rebuild a per-Story result row from the
 * Story ticket's live state when the sub-agent return cannot be trusted.
 *
 * The result is always conservative — `status: 'failed'` unless the live
 * ticket carries `agent::done` (or `state: 'closed'`). The phase / counters
 * are best-effort, sourced from the Story's `story-run-progress` comment;
 * absence of the comment is non-fatal.
 *
 * @param {{
 *   provider: { getTicket: Function, getTicketComments: Function },
 *   storyId: number,
 * }} args
 * @returns {Promise<{
 *   storyId: number,
 *   status: 'done' | 'failed',
 *   phase?: string,
 *   tasksDone?: number,
 *   tasksTotal?: number,
 *   reconciledFromGitHub: true,
 *   reconcileError?: string,
 * }>}
 */
export async function reconcileStoryFromGitHub({ provider, storyId } = {}) {
  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new TypeError(
      'reconcileStoryFromGitHub: storyId must be a positive integer',
    );
  }
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new TypeError(
      'reconcileStoryFromGitHub: provider.getTicket is required',
    );
  }

  let ticket;
  try {
    ticket = await provider.getTicket(storyId, { fresh: true });
  } catch (err) {
    return {
      storyId,
      status: 'failed',
      reconciledFromGitHub: true,
      reconcileError: err?.message ?? String(err),
    };
  }

  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  const isDone = labels.includes('agent::done') || ticket?.state === 'closed';
  const status = isDone ? 'done' : 'failed';

  const out = { storyId, status, reconciledFromGitHub: true };

  // Cross-look the story-run-progress comment for phase / task counters.
  // Failure here is non-fatal — `failed` with no counters is still a valid
  // reconciled row.
  try {
    const comment = await findStructuredComment(
      provider,
      storyId,
      STORY_RUN_PROGRESS_TYPE,
    );
    const payload = comment ? parseFencedJsonComment(comment) : null;
    if (payload && typeof payload === 'object') {
      if (typeof payload.phase === 'string') out.phase = payload.phase;
      if (Array.isArray(payload.tasks)) {
        out.tasksTotal = payload.tasks.length;
        out.tasksDone = payload.tasks.filter(
          (t) => t && t.state === 'done',
        ).length;
      }
    }
  } catch (err) {
    out.reconcileError = err?.message ?? String(err);
  }

  return out;
}

/**
 * Render a single friction-comment body listing every malformed sub-agent
 * return for a given wave. Pure helper — no provider call. Exposed so tests
 * can pin the body shape.
 *
 * @param {{
 *   epicId: number,
 *   wave: number,
 *   failures: Array<{ storyId: number, error: string, returnText: string }>,
 * }} args
 * @returns {string}
 */
export function renderMalformedReturnsFriction({ epicId, wave, failures }) {
  const lines = [
    `### 🚧 epic-execute friction — Epic #${epicId}, wave ${wave}`,
    '',
    `**Reason:** \`malformed-subagent-return\``,
    '',
    `${failures.length} sub-agent return(s) did not match the /story-execute return contract.`,
    'Each Story below was reconciled from GitHub (labels + `story-run-progress`)',
    'and its wave-row downgraded to `failed` unless the live ticket already carried',
    '`agent::done`.',
    '',
  ];
  for (const f of failures) {
    lines.push(`- **Story #${f.storyId}** — ${f.error}`);
    if (f.returnText) {
      lines.push(`  Original return: \`${quote(f.returnText)}\``);
    }
  }
  return lines.join('\n');
}
