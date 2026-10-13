/**
 * review-providers/claude-verdict.js — reads `code-review`'s claude result
 * envelope and auth-status payload into findings or a no-verdict reason.
 *
 * @typedef {import('./types.js').Finding} Finding
 */

import { buildFinding, unwrapEnvelope } from './parse-findings.js';

export const FINDINGS_SCHEMA_JSON = JSON.stringify({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          category: { type: 'string' },
        },
        required: ['title', 'body'],
      },
    },
  },
  required: ['findings'],
});

const MAX_DETAIL_CHARS = 300;
const USAGE_LIMIT_RE = /hit your .*limit|usage limit|rate limit/i;

export function clip(text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MAX_DETAIL_CHARS
    ? `${flat.slice(0, MAX_DETAIL_CHARS)}…`
    : flat;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `claude auth status --json`. Only `authMethod` and `subscriptionType`
 * are ever named: the payload also carries the account email, org name
 * and ids, which no reason or log line may repeat.
 *
 * @param {{ status: number, stdout: string }} result
 * @returns {{ ok: true, detail: string } | { ok: false, reason: string }}
 */
export function readAuthStatus(result) {
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `claude auth status exited ${result.status}: the CLI is not logged in or unusable`,
    };
  }
  const parsed = tryParseJson(result.stdout);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: 'claude auth status returned unparseable output',
    };
  }
  const method =
    typeof parsed.authMethod === 'string' ? parsed.authMethod : null;
  if (parsed.loggedIn !== true) {
    return {
      ok: false,
      reason: `claude CLI is not logged in${method ? ` (authMethod: ${method})` : ''}`,
    };
  }
  const plan =
    typeof parsed.subscriptionType === 'string'
      ? `, subscriptionType: ${parsed.subscriptionType}`
      : '';
  return { ok: true, detail: `authMethod: ${method ?? 'unknown'}${plan}` };
}

/**
 * The end index of the balanced JSON array opening at `start`, string-aware.
 *
 * @param {string} text
 * @param {number} start - index of a `[`.
 * @returns {number} index of the closing `]`, or -1.
 */
function matchArrayEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The last top-level JSON array in free text.
 *
 * @param {string} text
 * @returns {unknown[] | undefined}
 */
function lastBareArray(text) {
  let found;
  let i = text.indexOf('[');
  while (i !== -1) {
    const end = matchArrayEnd(text, i);
    const parsed =
      end === -1 ? undefined : tryParseJson(text.slice(i, end + 1));
    if (Array.isArray(parsed)) {
      found = parsed;
      i = text.indexOf('[', end + 1);
    } else {
      i = text.indexOf('[', i + 1);
    }
  }
  return found;
}

/**
 * The findings list from a JSON value: a bare array or `{ findings }`.
 *
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function asFindingList(value) {
  if (value === undefined) return undefined;
  const unwrapped = unwrapEnvelope(value);
  return Array.isArray(unwrapped) ? unwrapped : undefined;
}

/**
 * Fallback over the envelope's `result` text: the last fenced block, else
 * the last top-level JSON array — so a prose preamble is still a verdict.
 *
 * @param {string} text
 * @returns {unknown[] | undefined}
 */
function parseVerdictText(text) {
  const fences = [...text.matchAll(/```[a-z]*[^\S\n]*\n([\s\S]*?)```/gi)];
  const lastFence = fences.at(-1);
  const fenced = lastFence
    ? asFindingList(tryParseJson(lastFence[1].trim()))
    : undefined;
  return fenced ?? lastBareArray(text);
}

function toFindings(entries) {
  return entries
    .map((entry) =>
      buildFinding(entry, {
        mapSeverity: () => 'critical',
        defaultCategory: 'bug',
      }),
    )
    .filter(Boolean);
}

function failureReason(result, envelope) {
  const resultText =
    typeof envelope?.result === 'string' ? envelope.result : '';
  const text = [result.stderr, resultText, result.stdout].join('\n');
  if (USAGE_LIMIT_RE.test(text)) {
    return 'the claude CLI account is out of quota (usage limit reached)';
  }
  if (result.status !== 0) {
    return `claude --print exited with status ${result.status}: ${
      clip(result.stderr || resultText || result.stdout) || '<no output>'
    }`;
  }
  if (envelope?.is_error === true) {
    return `the reviewer returned an error result: ${clip(resultText) || '<no output>'}`;
  }
  return `the reviewer run ended with subtype ${clip(envelope?.subtype)}`;
}

/**
 * Verdict resolution: (a) a successful envelope's `structured_output`,
 * (b) the fallback parser over its `result` text, (c) no verdict.
 *
 * @param {{ status: number, stdout: string, stderr: string }} result
 * @returns {{ findings: Finding[] } | { reason: string }}
 */
export function resolveVerdict(result) {
  const parsed = tryParseJson(result.stdout);
  const envelope =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  const succeeded =
    result.status === 0 &&
    envelope !== null &&
    envelope.is_error !== true &&
    envelope.subtype === 'success';
  if (!succeeded) {
    if (result.status === 0 && envelope === null) {
      return {
        reason: 'the reviewer output was not a JSON result envelope',
      };
    }
    return { reason: failureReason(result, envelope) };
  }
  const structured = envelope.structured_output;
  if (
    structured &&
    typeof structured === 'object' &&
    Array.isArray(structured.findings)
  ) {
    return { findings: toFindings(structured.findings) };
  }
  const fallback =
    typeof envelope.result === 'string'
      ? parseVerdictText(envelope.result)
      : undefined;
  if (fallback) return { findings: toFindings(fallback) };
  return { reason: 'the reviewer output did not parse as a findings verdict' };
}
