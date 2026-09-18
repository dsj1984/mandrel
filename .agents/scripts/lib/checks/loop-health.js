/**
 * Read-only retro check for the feedback-loop substrate — an empty feedback
 * report looks healthy, so this surfaces schema-invalid signal samples
 * (validated with the writer's own validator) and actionable retro
 * proposals neither filed nor discarded. A clean substrate yields no finding.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { mainCheckoutRoot, tempRootFrom } from '../config/temp-paths.js';
import { validateSignal } from '../observability/signal-validator.js';

/** Tail window per stream: a bounded health probe, not an audit. */
const MAX_SAMPLE_LINES = 200;

/**
 * Most-recently-touched `run-<id>` temp tree, or `null`.
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
    const match = /^run-(\d+)$/.exec(entry);
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
 * The run-level stream plus each per-Story stream.
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
 * Unparseable lines count as invalid; an unreadable stream counts zero.
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
 * Unfiled = a `### Proposed issues` item carrying a `gh issue create` stanza
 * and no `Filed:` line. Discarded proposals sit under another heading.
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
    if (current?.actionable && !current.filed) {
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
 * One combined finding when either dimension is non-clean, else `null`.
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

  let retroText = '';
  try {
    retroText = readImpl(path.join(epicDir, 'retro.md'), 'utf8');
  } catch {
    retroText = '';
  }
  const unfiledProposals = scanRetroMirror(retroText);

  const signalConcern = invalidCount > 0;
  const proposalConcern = unfiledProposals.length > 0;
  if (!signalConcern && !proposalConcern) return null;

  const summaryParts = [];
  const detailLines = [];
  if (signalConcern) {
    summaryParts.push(`${invalidCount} schema-invalid signal sample(s)`);
    detailLines.push(
      `Sampled ${sampled} line(s) across ${streams.length} signals.ndjson stream(s) (last ${maxLines} per stream):`,
      `  schema-invalid samples: ${invalidCount}`,
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
    summary: `Loop-health (run-${epicId}): ${summaryParts.join('; ')}.`,
    detail: detailLines.join('\n'),
    fixCommand:
      'Inspect temp/run-<id>/{signals.ndjson,retro.md}; fix the signal producer or file/discard the surfaced proposals.',
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
