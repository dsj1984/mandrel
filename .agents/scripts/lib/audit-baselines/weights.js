/**
 * Hotspot ranking multipliers — churn, import in-degree, friction signals.
 * Each input is optional and degrades to exactly 1.0: never 0 (which would
 * erase the hotspot), never a guess.
 *
 * @module lib/audit-baselines/weights
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileCapture } from '../child-exec.js';
import { computeInDegree, resolveRepoGraph } from '../import-graph.js';

const NEUTRAL_WEIGHT = 1.0;

/**
 * Saturating count → `[1, 2)`; zero equals the degraded weight, so neither
 * moves the ranking.
 *
 * @param {number} count
 * @param {number} half count at which the multiplier reaches 1.5
 * @returns {number}
 */
function saturate(count, half) {
  if (!Number.isFinite(count) || count <= 0) return NEUTRAL_WEIGHT;
  return NEUTRAL_WEIGHT + count / (count + half);
}

/**
 * Commits per file in the window; `degraded` when git cannot answer at all.
 *
 * @param {{ cwd: string, windowDays?: number, run?: Function }} args
 * @returns {{ counts: Map<string, number>, degraded: boolean }}
 */
export function readChurn({ cwd, windowDays = 180, run }) {
  let stdout;
  try {
    stdout = execFileCapture(
      'git',
      [
        'log',
        `--since=${windowDays}.days.ago`,
        '--name-only',
        '--pretty=format:',
        '--no-renames',
      ],
      {
        run,
        cwd,
        // Degradation is reported in the envelope, not on stderr.
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return { counts: new Map(), degraded: true };
  }
  const counts = new Map();
  for (const line of String(stdout).split('\n')) {
    const file = line.trim();
    if (file.length === 0) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return { counts, degraded: false };
}

/**
 * @param {{ cwd: string, graph?: Map<string, string[]> | null }} args
 * @returns {{ degrees: Map<string, number>, degraded: boolean }}
 */
export function readCentrality({ cwd, graph }) {
  const resolved = graph === undefined ? resolveRepoGraph(cwd) : graph;
  if (!resolved) return { degrees: new Map(), degraded: true };
  return { degrees: computeInDegree(resolved), degraded: false };
}

const PATH_TOKEN_RE = /[\w@][\w./@-]*\.(?:js|mjs|cjs|ts|tsx|json|md)\b/g;

/**
 * @param {string} tempRootAbs
 * @returns {string[]} absolute paths
 */
function findSignalStreams(tempRootAbs) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.name === 'signals.ndjson') out.push(child);
    }
  };
  walk(tempRootAbs, 0);
  return out.sort();
}

/**
 * Friction signals per blamed file. Records have no path field, so paths are
 * token-scanned from `details` / `emitter.command`; bad lines are skipped.
 *
 * @param {{ tempRootAbs: string, kinds?: Set<string> }} args
 * @returns {{ counts: Map<string, number>, degraded: boolean, streams: number }}
 */
export function readFriction({
  tempRootAbs,
  kinds = new Set(['friction', 'hotspot', 'rework', 'churn', 'retry']),
}) {
  const streams = findSignalStreams(tempRootAbs);
  if (streams.length === 0) {
    return { counts: new Map(), degraded: true, streams: 0 };
  }
  const counts = new Map();
  for (const stream of streams) {
    let raw;
    try {
      raw = fs.readFileSync(stream, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!kinds.has(record?.kind)) continue;
      const text =
        JSON.stringify(record.details ?? {}) + (record?.emitter?.command ?? '');
      for (const token of text.match(PATH_TOKEN_RE) ?? []) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  return { counts, degraded: false, streams: streams.length };
}

/**
 * @param {{
 *   churn: { counts: Map<string, number>, degraded: boolean },
 *   centrality: { degrees: Map<string, number>, degraded: boolean },
 *   friction: { counts: Map<string, number>, degraded: boolean },
 * }} sources
 * @returns {(id: string) => { churnWeight: number, centralityWeight: number, frictionWeight: number }}
 */
export function makeWeightResolver({ churn, centrality, friction }) {
  return (id) => ({
    churnWeight: churn.degraded
      ? NEUTRAL_WEIGHT
      : saturate(churn.counts.get(id) ?? 0, 12),
    centralityWeight: centrality.degraded
      ? NEUTRAL_WEIGHT
      : saturate(centrality.degrees.get(id) ?? 0, 8),
    frictionWeight: friction.degraded
      ? NEUTRAL_WEIGHT
      : saturate(friction.counts.get(id) ?? 0, 4),
  });
}
