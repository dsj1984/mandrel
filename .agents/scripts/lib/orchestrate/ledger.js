/**
 * ledger.js — the append-only record of one `/mandrel-orchestrate` run:
 * the operator's authority, every sweep's states, and every action taken.
 * Authority is written only by `recordAuthority`, never from GitHub content.
 */

import fs from 'node:fs';
import path from 'node:path';

import { orchestrateRunDir } from '../config/temp-paths.js';

/** The closed action set and the default the operator is offered for each. */
export const ACTION_DEFAULTS = Object.freeze({
  'message-session': 'yes',
  'fix-base': 'yes',
  requeue: 'ask',
  'arm-auto-merge': 'ask',
  'push-to-branch': 'no',
  'spawn-session': 'ask',
  'release-dispatch': 'no',
  'archive-and-reap': 'ask',
});

/** Recorded without a grant: putting an item to the operator, filing a follow-up. */
const ALWAYS_ALLOWED = new Set(['raise', 'follow-up']);

export function ledgerPath(runId, config) {
  return path.join(orchestrateRunDir(runId, config), 'ledger.ndjson');
}

/** Every parseable record, oldest first; a missing ledger is empty. */
export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn trailing line from an interrupted append is skipped.
    }
  }
  return records;
}

function append(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

const authorityOf = (records) =>
  records.find((r) => r.kind === 'authority') ?? null;

export const lastSweep = (records) =>
  records.findLast((r) => r.kind === 'sweep') ?? null;

/**
 * @returns {{ ok: boolean, reason?: string, record?: object }}
 */
export function recordAuthority({ file, grants, now = Date.now() }) {
  const unknown = grants.filter((g) => !Object.hasOwn(ACTION_DEFAULTS, g));
  if (unknown.length > 0)
    return { ok: false, reason: `unknown-action: ${unknown.join(', ')}` };
  if (authorityOf(readLedger(file)))
    return { ok: false, reason: 'authority-already-recorded' };
  const record = {
    kind: 'authority',
    at: new Date(now).toISOString(),
    grants: [...new Set(grants)],
  };
  append(file, record);
  return { ok: true, record };
}

function refusal(records, { action, text }) {
  if (typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text))
    return 'text-must-be-one-line';
  const authority = authorityOf(records);
  if (!authority) return 'no-authority';
  if (ALWAYS_ALLOWED.has(action)) return null;
  if (!Object.hasOwn(ACTION_DEFAULTS, action))
    return `unknown-action: ${action}`;
  if (!authority.grants.includes(action)) return `not-granted: ${action}`;
  return null;
}

/**
 * Record an action before it is taken. A refused action writes nothing.
 * A second `raise` for the same PR and state is refused: each case reaches
 * the operator once.
 *
 * @returns {{ ok: boolean, reason?: string, record?: object }}
 */
export function recordAction({
  file,
  action,
  pr = null,
  story = null,
  text,
  now = Date.now(),
}) {
  const records = readLedger(file);
  const reason = refusal(records, { action, text });
  if (reason) return { ok: false, reason };
  const state = pr == null ? null : (lastSweep(records)?.states?.[pr] ?? null);
  if (action === 'raise') {
    const twice = records.some(
      (r) =>
        r.kind === 'action' &&
        r.action === 'raise' &&
        r.pr === pr &&
        r.story === story &&
        r.state === state,
    );
    if (twice) return { ok: false, reason: 'already-raised' };
  }
  const record = {
    kind: 'action',
    at: new Date(now).toISOString(),
    action,
    pr,
    story,
    state,
    text: text.trim(),
  };
  append(file, record);
  return { ok: true, record };
}

/**
 * PRs whose state differs from the previous sweep; a new PR comes `from:
 * null`, a gone one goes `to: null`.
 *
 * @param {Record<string, string>|null} before
 * @param {Record<string, string>} after
 */
export function sweepChanges(before, after) {
  const prior = before ?? {};
  const numbers = new Set([...Object.keys(prior), ...Object.keys(after)]);
  return [...numbers]
    .filter((n) => prior[n] !== after[n])
    .map((n) => ({
      number: Number(n),
      from: prior[n] ?? null,
      to: after[n] ?? null,
    }))
    .sort((a, b) => a.number - b.number);
}

/** Merges are counted from here: the previous sweep, else the authority. */
export function landedSince(records) {
  return lastSweep(records)?.at ?? authorityOf(records)?.at ?? null;
}

export function recordSweep({ file, states, merged, now = Date.now() }) {
  append(file, {
    kind: 'sweep',
    at: new Date(now).toISOString(),
    states,
    merged,
  });
}

/**
 * The hand-back, from the ledger alone.
 *
 * @param {object[]} records
 */
export function summarize(records) {
  const sweep = lastSweep(records);
  const states = sweep?.states ?? {};
  const merged = new Map();
  for (const r of records) {
    if (r.kind === 'sweep')
      for (const m of r.merged ?? []) merged.set(m.number, m);
  }
  const actions = records.filter((r) => r.kind === 'action');
  const stillCurrent = (r) => r.pr == null || states[r.pr] === r.state;
  return {
    merged: [...merged.values()],
    open: Object.entries(states).map(([number, state]) => ({
      number: Number(number),
      state,
    })),
    waiting: actions.filter((r) => r.action === 'raise' && stillCurrent(r)),
    followUps: actions.filter((r) => r.action === 'follow-up'),
    taken: actions.filter((r) => !ALWAYS_ALLOWED.has(r.action)),
  };
}

const prLabel = (r) =>
  r.pr == null ? (r.story ? `Story #${r.story}` : 'run') : `PR #${r.pr}`;

export function renderSummary(summary) {
  const section = (title, rows) => [
    `${title} (${rows.length})`,
    ...rows.map((row) => `- ${row}`),
  ];
  return `${[
    ...section(
      'Merged',
      summary.merged.map(
        (m) => `PR #${m.number}${m.storyId ? ` (Story #${m.storyId})` : ''}`,
      ),
    ),
    ...section(
      'Still open',
      summary.open.map((o) => `PR #${o.number}: ${o.state}`),
    ),
    ...section(
      'Waiting on the operator',
      summary.waiting.map((r) => `${prLabel(r)}: ${r.text}`),
    ),
    ...section(
      'Follow-ups filed',
      summary.followUps.map((r) => `${prLabel(r)}: ${r.text}`),
    ),
    ...section(
      'Actions taken',
      summary.taken.map((r) => `${r.action} ${prLabel(r)}: ${r.text}`),
    ),
  ].join('\n')}\n`;
}
