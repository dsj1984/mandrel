/**
 * Read Claude Code session transcripts into one cost row per session and per
 * spawned subagent (Story #5607).
 *
 * Claude Code writes `<projectDir>/<sessionId>.jsonl` for each top-level
 * session and `<projectDir>/<sessionId>/subagents/agent-<id>.jsonl` (plus a
 * sibling `agent-<id>.meta.json`) for each subagent. Only metadata fields are
 * read — `message.id`, `message.model`, `message.usage`, `effort`,
 * `attributionSkill`, `apiBlockIndex`, `timestamp` — and only those reach a
 * row. Message content, tool inputs and tool results are never copied.
 *
 * Dedup contract: one API message is written as several records (one per
 * content block, `apiBlockIndex` 0..n), each repeating the message's usage.
 * Each `message.id` counts exactly once, from its highest-`apiBlockIndex`
 * record; summing raw records overcounts input and cache tokens several-fold.
 */

import fs from 'node:fs';
import path from 'node:path';

const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;
const STORY_ID = /\bStory\b\D*?#?(\d+)/;
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * @typedef {object} CostRow
 * @property {string} sessionId
 * @property {string|null} agentId
 * @property {string} agentType
 * @property {string|null} description
 * @property {number|null} storyId
 * @property {string|null} skill
 * @property {string[]} models
 * @property {string[]} efforts
 * @property {string|null} primaryModel
 * @property {string|null} primaryEffort
 * @property {number} effortChanges
 * @property {number} messages
 * @property {number} inputTokens
 * @property {number} cacheCreationTokens
 * @property {number} cacheReadTokens
 * @property {number} outputTokens
 * @property {number} thinkingTokens
 * @property {number} totalTokens
 * @property {number} cacheCreationAfterFirstEffortChange
 * @property {string|null} startedAt
 * @property {string|null} endedAt
 * @property {number|null} wallMs
 */

/**
 * Most frequent value; ties go to the first-seen value.
 *
 * @param {Array<string|null|undefined>} values
 * @returns {string|null}
 */
function mostFrequent(values) {
  const counts = new Map();
  for (const v of values) {
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

/**
 * @param {Array<string|null|undefined>} values
 * @returns {string[]} distinct non-null values in first-seen order
 */
function distinct(values) {
  return [...new Set(values.filter((v) => v != null))];
}

/**
 * Parse a JSONL file into records, counting lines that are not JSON.
 *
 * @param {string} text
 * @returns {{ records: object[], skippedLines: number }}
 */
function parseJsonl(text) {
  const records = [];
  let skippedLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  return { records, skippedLines };
}

/**
 * Collapse usage-bearing assistant records to one entry per API message,
 * keeping the highest-`apiBlockIndex` record, ordered by first appearance.
 *
 * @param {object[]} records
 * @returns {object[]} the kept records
 */
function dedupeMessages(records) {
  const byId = new Map();
  records.forEach((record, index) => {
    const message = record.message;
    if (record.type !== 'assistant' || !message?.usage) return;
    if (message.model === SYNTHETIC_MODEL) return;
    const key = message.id ?? record.uuid ?? `line-${index}`;
    const block = Number(record.apiBlockIndex ?? 0);
    const held = byId.get(key);
    if (!held) {
      byId.set(key, { record, block, order: index });
    } else if (block >= held.block) {
      byId.set(key, { record, block, order: held.order });
    }
  });
  return [...byId.values()]
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.record);
}

/**
 * @param {object} usage
 * @returns {{ input: number, cacheCreation: number, cacheRead: number,
 *   output: number, thinking: number }}
 */
function usageTokens(usage) {
  return {
    input: Number(usage.input_tokens ?? 0),
    cacheCreation: Number(usage.cache_creation_input_tokens ?? 0),
    cacheRead: Number(usage.cache_read_input_tokens ?? 0),
    output: Number(usage.output_tokens ?? 0),
    thinking: Number(usage.output_tokens_details?.thinking_tokens ?? 0),
  };
}

/**
 * Count adjacent-message effort changes and the cache-creation tokens spent
 * from the first change onward (the cache rebuild a mid-session raise costs).
 *
 * @param {object[]} messages deduped records in order
 * @returns {{ effortChanges: number, cacheCreationAfterFirstEffortChange: number }}
 */
function effortChurn(messages) {
  let effortChanges = 0;
  let afterFirst = 0;
  let changed = false;
  let previous = null;
  for (const record of messages) {
    const effort = record.effort ?? null;
    if (previous != null && effort != null && effort !== previous) {
      effortChanges += 1;
      changed = true;
    }
    if (effort != null) previous = effort;
    if (changed) {
      afterFirst += usageTokens(record.message.usage).cacheCreation;
    }
  }
  return { effortChanges, cacheCreationAfterFirstEffortChange: afterFirst };
}

/**
 * @param {object[]} records
 * @returns {{ startedAt: string|null, endedAt: string|null, wallMs: number|null }}
 */
function timeSpan(records) {
  let min = Infinity;
  let max = -Infinity;
  for (const record of records) {
    const t = Date.parse(record.timestamp ?? '');
    if (Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity) return { startedAt: null, endedAt: null, wallMs: null };
  return {
    startedAt: new Date(min).toISOString(),
    endedAt: new Date(max).toISOString(),
    wallMs: max - min,
  };
}

/**
 * @param {string|null} description
 * @returns {number|null}
 */
function storyIdFrom(description) {
  if (typeof description !== 'string') return null;
  const match = STORY_ID.exec(description);
  return match ? Number(match[1]) : null;
}

/**
 * Build one cost row from a transcript's parsed records.
 *
 * @param {object[]} records
 * @param {{ sessionId: string, agentId: string|null, agentType: string,
 *   description: string|null }} identity
 * @returns {CostRow}
 */
function buildRow(records, identity) {
  const messages = dedupeMessages(records);
  const totals = {
    input: 0,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  };
  for (const record of messages) {
    const t = usageTokens(record.message.usage);
    for (const key of Object.keys(totals)) totals[key] += t[key];
  }
  const modelList = messages.map((r) => r.message.model ?? null);
  const effortList = messages.map((r) => r.effort ?? null);
  return {
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    agentType: identity.agentType,
    description: identity.description,
    storyId: storyIdFrom(identity.description),
    skill: mostFrequent(messages.map((r) => r.attributionSkill ?? null)),
    models: distinct(modelList),
    efforts: distinct(effortList),
    primaryModel: mostFrequent(modelList),
    primaryEffort: mostFrequent(effortList),
    ...effortChurn(messages),
    messages: messages.length,
    inputTokens: totals.input,
    cacheCreationTokens: totals.cacheCreation,
    cacheReadTokens: totals.cacheRead,
    outputTokens: totals.output,
    thinkingTokens: totals.thinking,
    totalTokens:
      totals.input + totals.cacheCreation + totals.cacheRead + totals.output,
    ...timeSpan(records),
  };
}

/**
 * @param {typeof fs} fsLike
 * @param {string} metaPath
 * @returns {{ agentType?: string, description?: string }}
 */
function readMeta(fsLike, metaPath) {
  try {
    const parsed = JSON.parse(fsLike.readFileSync(metaPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A file last modified before `sinceMs` cannot hold a record after it.
 *
 * @param {typeof fs} fsLike
 * @param {string} file
 * @param {number|null} sinceMs
 */
function staleBefore(fsLike, file, sinceMs) {
  if (sinceMs == null) return false;
  return fsLike.statSync(file).mtimeMs < sinceMs;
}

/**
 * @param {typeof fs} fsLike
 * @param {string} file
 * @param {object} identity
 * @param {{ rows: CostRow[], skippedLines: number }} acc
 */
function readOne(fsLike, file, identity, acc) {
  const { records, skippedLines } = parseJsonl(
    fsLike.readFileSync(file, 'utf8'),
  );
  acc.skippedLines += skippedLines;
  acc.rows.push(buildRow(records, identity));
}

/**
 * @param {typeof fs} fsLike
 * @param {string} projectDir
 * @param {string} sessionId
 * @param {number|null} sinceMs
 * @param {{ rows: CostRow[], skippedLines: number }} acc
 */
function readSubagents(fsLike, projectDir, sessionId, sinceMs, acc) {
  const dir = path.join(projectDir, sessionId, 'subagents');
  if (!fsLike.existsSync(dir)) return;
  for (const name of fsLike.readdirSync(dir).sort()) {
    const match = SUBAGENT_FILE.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    if (staleBefore(fsLike, file, sinceMs)) continue;
    const meta = readMeta(
      fsLike,
      path.join(dir, `agent-${match[1]}.meta.json`),
    );
    readOne(
      fsLike,
      file,
      {
        sessionId,
        agentId: match[1],
        agentType:
          typeof meta.agentType === 'string' ? meta.agentType : 'unknown',
        description:
          typeof meta.description === 'string' ? meta.description : null,
      },
      acc,
    );
  }
}

/**
 * Read every session and subagent transcript under one projects directory.
 *
 * @param {string} projectDir
 * @param {{ fs?: typeof fs, sinceMs?: number|null }} [opts]
 * @returns {{ rows: CostRow[], skippedLines: number }}
 */
export function readProjectDir(projectDir, opts = {}) {
  const fsLike = opts.fs ?? fs;
  const sinceMs = opts.sinceMs ?? null;
  const acc = { rows: [], skippedLines: 0 };
  const sessionIds = new Set();
  for (const name of fsLike.readdirSync(projectDir).sort()) {
    if (name.endsWith('.jsonl')) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      sessionIds.add(sessionId);
      const file = path.join(projectDir, name);
      if (!staleBefore(fsLike, file, sinceMs)) {
        readOne(
          fsLike,
          file,
          { sessionId, agentId: null, agentType: 'main', description: null },
          acc,
        );
      }
    } else if (fsLike.statSync(path.join(projectDir, name)).isDirectory()) {
      sessionIds.add(name);
    }
  }
  for (const sessionId of [...sessionIds].sort()) {
    readSubagents(fsLike, projectDir, sessionId, sinceMs, acc);
  }
  return acc;
}
