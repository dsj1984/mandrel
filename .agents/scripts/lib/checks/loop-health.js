/**
 * loop-health.js — read-only retro-scope check for the feedback-loop
 * substrate (Epic #4406 / Story #4419, the terminal slice).
 *
 * The original feedback-loop drift shipped silently because an empty
 * feedback report is indistinguishable from a healthy one. This standing
 * self-check closes that gap: at retro time it samples the on-disk signal
 * substrate the sibling Stories established and surfaces the three ways the
 * repaired loop can regress without anyone noticing:
 *
 *   1. **Schema-invalid signal lines.** It tails the most recent
 *      {@link MAX_SAMPLE_LINES} lines of every `signals.ndjson` stream under
 *      the Epic temp tree and validates each against the canonical
 *      `signal-event.schema.json` (via `validateSignal`, the same validator
 *      the writer uses — no hand-rolled drift).
 *   2. **Persisted write-time rejects.** It reads the per-Epic reject tally
 *      (`temp/epic-<id>/signal-rejects.json`, written by Story #4413's
 *      signals-writer) so records that were dropped at write time — and thus
 *      never appear in the stream — are still counted.
 *   3. **Un-actioned retro proposals.** It reads the retro mirror
 *      (`temp/epic-<id>/retro.md`, Story #4418) and flags any actionable
 *      "Proposed issues" item that carries neither a filed-issue reference
 *      (`Filed: [#N](url)`) nor lives under the explicit "One-off /
 *      discarded" record.
 *
 * Contract:
 *   - Scope `retro`, `autoCorrect: 'refuse-and-print'` — read-only by
 *     construction; the runner refuses `autoFix` under the retro scope.
 *   - A clean substrate (valid lines, zero rejects, every proposal filed or
 *     discarded) yields **zero findings**, preserving the compact retro
 *     shape. Only when a concern is non-zero does `detect` return a single
 *     combined finding naming every non-clean dimension.
 *   - No new provider plumbing: `detect(state)` reads `state.cwd` from the
 *     existing cwd-scoped checks-registry state, anchors it to the main
 *     checkout root, and reads the temp tree directly.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { mainCheckoutRoot, tempRootFrom } from '../config/temp-paths.js';
import { validateSignal } from '../observability/signal-validator.js';

/**
 * Lines sampled from the tail of each `signals.ndjson` stream. The check is
 * a health probe, not an exhaustive audit — the most recent window is a
 * representative sample that keeps the read bounded on long streams.
 */
export const MAX_SAMPLE_LINES = 200;

/**
 * Locate the most-recently-touched `epic-<id>` temp tree under
 * `<baseDir>/<tempRoot>`. Returns `{ epicId, epicDir }` or `null` when no
 * Epic temp tree exists (a fresh checkout, or a non-Epic context).
 *
 * @param {string} baseDir  The main checkout root.
 * @param {{ tempRoot?: string, fsImpl?: { readdirSync: typeof readdirSync, statSync: typeof statSync } }} [opts]
 * @returns {{ epicId: number, epicDir: string } | null}
 */
export function resolveEpicTempTree(
  baseDir,
  { tempRoot = 'temp', fsImpl } = {},
) {
  const readdir = fsImpl?.readdirSync ?? readdirSync;
  const stat = fsImpl?.statSync ?? statSync;
  const tempDir = path.join(baseDir, tempRoot);
  let entries;
  try {
    entries = readdir(tempDir);
  } catch {
    return null;
  }
  let best = null;
  for (const entry of entries) {
    const match = /^epic-(\d+)$/.exec(entry);
    if (!match) continue;
    const full = path.join(tempDir, entry);
    let st;
    try {
      st = stat(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { epicId: Number(match[1]), epicDir: full, mtimeMs: st.mtimeMs };
    }
  }
  return best ? { epicId: best.epicId, epicDir: best.epicDir } : null;
}

/**
 * Enumerate every `signals.ndjson` stream under an Epic temp tree: the
 * Epic-level wave-lifecycle stream plus each per-Story stream.
 *
 * @param {string} epicDir
 * @param {{ fsImpl?: { readdirSync: typeof readdirSync, statSync: typeof statSync } }} [opts]
 * @returns {string[]}
 */
export function findSignalStreams(epicDir, { fsImpl } = {}) {
  const readdir = fsImpl?.readdirSync ?? readdirSync;
  const stat = fsImpl?.statSync ?? statSync;
  const streams = [];
  const isFile = (p) => {
    try {
      return stat(p).isFile();
    } catch {
      return false;
    }
  };
  const epicSignals = path.join(epicDir, 'signals.ndjson');
  if (isFile(epicSignals)) streams.push(epicSignals);
  const storiesDir = path.join(epicDir, 'stories');
  let storyEntries;
  try {
    storyEntries = readdir(storiesDir);
  } catch {
    storyEntries = [];
  }
  for (const entry of storyEntries) {
    if (!/^story-\d+$/.test(entry)) continue;
    const storySignals = path.join(storiesDir, entry, 'signals.ndjson');
    if (isFile(storySignals)) streams.push(storySignals);
  }
  return streams;
}

/**
 * Tail `maxLines` of a single stream and count how many sampled lines fail
 * the canonical schema (a JSON parse failure counts as invalid). A missing
 * or unreadable stream contributes zero — absence is not invalidity.
 *
 * @param {string} streamPath
 * @param {{ validate?: typeof validateSignal, maxLines?: number, readImpl?: typeof readFileSync }} [opts]
 * @returns {{ sampled: number, invalid: number }}
 */
export function sampleStreamInvalidCount(
  streamPath,
  {
    validate = validateSignal,
    maxLines = MAX_SAMPLE_LINES,
    readImpl = readFileSync,
  } = {},
) {
  let raw;
  try {
    raw = readImpl(streamPath, 'utf8');
  } catch {
    return { sampled: 0, invalid: 0 };
  }
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-maxLines);
  let invalid = 0;
  for (const line of tail) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    if (!validate(parsed).valid) invalid += 1;
  }
  return { sampled: tail.length, invalid };
}

/**
 * Read the per-Epic persisted reject count from `signal-rejects.json`.
 * Returns 0 when the tally is absent or unreadable.
 *
 * @param {string} epicDir
 * @param {{ readImpl?: typeof readFileSync }} [opts]
 * @returns {number}
 */
export function readRejectTally(epicDir, { readImpl = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(
      readImpl(path.join(epicDir, 'signal-rejects.json'), 'utf8'),
    );
    return parsed && Number.isFinite(parsed.count) ? parsed.count : 0;
  } catch {
    return 0;
  }
}

/**
 * Scan a retro mirror body for actionable proposals that were neither filed
 * nor discarded. An actionable proposal is a `- **Title**` item under a
 * `### Proposed issues` heading whose body carries a paste-ready
 * `gh issue create` stanza (the un-filed fallback) instead of a
 * `Filed: [#N](url)` reference. Discarded proposals live under the separate
 * "### One-off / discarded" heading and are never scanned here.
 *
 * @param {string} retroText
 * @returns {string[]}  Titles of unfiled actionable proposals.
 */
export function scanRetroMirror(retroText) {
  if (typeof retroText !== 'string' || retroText.length === 0) return [];
  const ACTION_HEADING = /^###\s+Proposed issues\b/;
  const ANY_HEADING = /^#{1,6}\s+/;
  const ITEM = /^-\s+\*\*(.+?)\*\*\s*$/;
  const unfiled = [];
  let inSection = false;
  let current = null;
  const flush = () => {
    if (current && current.actionable && !current.filed) {
      unfiled.push(current.title);
    }
    current = null;
  };
  for (const line of retroText.split('\n')) {
    if (ANY_HEADING.test(line)) {
      flush();
      inSection = ACTION_HEADING.test(line);
      continue;
    }
    if (!inSection) continue;
    const itemMatch = ITEM.exec(line);
    if (itemMatch) {
      flush();
      current = { title: itemMatch[1].trim(), filed: false, actionable: false };
      continue;
    }
    if (!current) continue;
    if (/^\s*Filed:/.test(line)) current.filed = true;
    if (/gh issue create/.test(line)) current.actionable = true;
  }
  flush();
  return unfiled;
}

/**
 * Core detection: locate the Epic temp tree under `baseDir`, sample its
 * signal streams, read its reject tally, and scan its retro mirror. Returns
 * a single combined finding when any dimension is non-clean, else `null`.
 *
 * @param {string} baseDir
 * @param {{
 *   tempRoot?: string,
 *   validate?: typeof validateSignal,
 *   maxLines?: number,
 *   scope?: string,
 *   fsImpl?: object,
 *   readImpl?: typeof readFileSync,
 * }} [opts]
 * @returns {import('./index.js').Finding | null}
 */
export function detectLoopHealth(
  baseDir,
  {
    tempRoot = 'temp',
    validate = validateSignal,
    maxLines = MAX_SAMPLE_LINES,
    scope = 'retro',
    fsImpl,
    readImpl = readFileSync,
  } = {},
) {
  const tree = resolveEpicTempTree(baseDir, { tempRoot, fsImpl });
  if (!tree) return null;
  const { epicId, epicDir } = tree;

  const streams = findSignalStreams(epicDir, { fsImpl });
  let invalidCount = 0;
  let sampled = 0;
  for (const stream of streams) {
    const r = sampleStreamInvalidCount(stream, {
      validate,
      maxLines,
      readImpl,
    });
    invalidCount += r.invalid;
    sampled += r.sampled;
  }

  const rejectCount = readRejectTally(epicDir, { readImpl });

  let retroText = '';
  try {
    retroText = readImpl(path.join(epicDir, 'retro.md'), 'utf8');
  } catch {
    retroText = '';
  }
  const unfiledProposals = scanRetroMirror(retroText);

  const signalConcern = invalidCount > 0 || rejectCount > 0;
  const proposalConcern = unfiledProposals.length > 0;
  if (!signalConcern && !proposalConcern) return null;

  const summaryParts = [];
  const detailLines = [];
  if (signalConcern) {
    summaryParts.push(
      `${invalidCount} schema-invalid signal sample(s), ${rejectCount} persisted reject(s)`,
    );
    detailLines.push(
      `Sampled ${sampled} line(s) across ${streams.length} signals.ndjson stream(s) (last ${maxLines} per stream):`,
      `  schema-invalid samples: ${invalidCount}`,
      `  persisted reject tally (signal-rejects.json): ${rejectCount}`,
    );
  }
  if (proposalConcern) {
    summaryParts.push(
      `${unfiledProposals.length} unfiled actionable proposal(s)`,
    );
    detailLines.push(
      'Retro proposals with neither a filed-issue reference nor a discard record:',
      ...unfiledProposals.map((title) => `  - ${title}`),
    );
  }

  return {
    id: 'loop-health',
    severity: 'warning',
    scope,
    summary: `Loop-health (epic-${epicId}): ${summaryParts.join('; ')}.`,
    detail: detailLines.join('\n'),
    fixCommand:
      'Inspect temp/epic-<id>/{signals.ndjson,signal-rejects.json,retro.md}; fix the signal producer or file/discard the surfaced proposals.',
    autoCorrectable: false,
  };
}

export default {
  id: 'loop-health',
  severity: 'warning',
  scope: ['retro'],
  autoCorrect: 'refuse-and-print',
  detect(state) {
    const cwd = state?.cwd ?? process.cwd();
    const baseDir = mainCheckoutRoot(cwd) ?? cwd;
    return detectLoopHealth(baseDir, {
      tempRoot: tempRootFrom(state?.config),
      scope: state?.scope ?? 'retro',
    });
  },
};
