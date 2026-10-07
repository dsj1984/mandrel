/**
 * Assembles the `/audit-exceptions` evidence envelope: every exception the
 * adapter registry finds, each with a mechanical verdict, plus the clusters,
 * skips, delegations and degradations the lens reads before judging. Read-only:
 * the only write is the caller's `--out` file. Evidence, not a verdict —
 * assembling it is success, including on every degraded input.
 *
 * @module lib/audit-exceptions/engine
 */

import path from 'node:path';
import { tempRootFrom } from '../config/temp-paths.js';
import { resolveConfig } from '../config-resolver.js';
import { ADAPTERS } from './adapters/index.js';
import { classifyAll, VERDICTS } from './classify.js';
import { buildDependencyIndex } from './dependency-index.js';
import { addBlame, DEFAULT_BLAME_LIMIT, markIntroduced } from './history.js';
import { runProbes } from './probe.js';
import { buildScope } from './scope.js';
import { DEFAULT_TICKET_LIMIT, resolveTicketStates } from './tickets.js';

/** Matches the shipped schema's const. */
const ENVELOPE_KIND = 'audit-exceptions-envelope';

/** Bump on any breaking shape change. */
const ENVELOPE_SCHEMA_VERSION = '1';

export const DEFAULT_MAX_RECORDS = 2000;

const CLUSTER_FILE_SAMPLE = 10;

/**
 * The temp root relative to the analysed repo; an unreadable config falls
 * back to the default so the run never aborts on it.
 *
 * @param {string} root
 * @returns {string}
 */
function tempRelFor(root) {
  try {
    const temp = tempRootFrom(resolveConfig({ cwd: root }));
    return path.isAbsolute(temp) ? path.relative(root, temp) : temp;
  } catch {
    return 'temp';
  }
}

function createContext(root, scope, degradations) {
  let index;
  return {
    root,
    scope,
    cache: {},
    deps: () => {
      if (!index) {
        index = buildDependencyIndex(scope, root);
        degradations.push(...index.degradations);
      }
      return index;
    },
    degrade: (input, detail) =>
      degradations.push({
        input,
        reason: 'input could not be read statically',
        detail,
      }),
  };
}

function runAdapters(ctx, degradations) {
  const adapters = [];
  const skipped = [];
  const records = [];
  for (const adapter of ADAPTERS) {
    const { applies, reason } = adapter.applies(ctx);
    if (!applies) {
      skipped.push({ id: adapter.id, reason });
      continue;
    }
    try {
      const found = adapter.extract(ctx);
      records.push(...found);
      adapters.push({
        id: adapter.id,
        category: adapter.category,
        recordCount: found.length,
      });
    } catch (err) {
      degradations.push({
        input: `adapter:${adapter.id}`,
        reason: 'adapter failed',
        detail: err?.message ?? String(err),
      });
    }
  }
  return { adapters, skipped, records };
}

function delegations(scope) {
  if (!scope.fileSet.has('.agentrc.json')) return [];
  return [
    {
      surface: '.agentrc.json delivery.quality.gates.*.ignoreGlobs',
      lens: 'audit-baselines',
      reason:
        '/audit-baselines owns dead gate ignore globs (gateSurface[].deadIgnoreGlobs)',
    },
  ];
}

function countBy(records, key, keys) {
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of records) counts[r[key]] = (counts[r[key]] ?? 0) + 1;
  return counts;
}

/** One cluster per `(adapter, rule)` — the unit the lens files a finding for. */
function buildClusters(records) {
  const clusters = new Map();
  for (const r of records) {
    const key = `${r.adapter}␟${r.rule}`;
    if (!clusters.has(key)) {
      clusters.set(key, {
        adapter: r.adapter,
        category: r.category,
        rule: r.rule,
        count: 0,
        byVerdict: countBy([], 'verdict', VERDICTS),
        files: [],
      });
    }
    const c = clusters.get(key);
    c.count += 1;
    c.byVerdict[r.verdict] += 1;
    if (c.files.length < CLUSTER_FILE_SAMPLE && !c.files.includes(r.file))
      c.files.push(r.file);
  }
  return [...clusters.values()].sort(
    (a, b) => b.count - a.count || a.rule.localeCompare(b.rule),
  );
}

const byLocation = (a, b) =>
  a.category.localeCompare(b.category) ||
  a.adapter.localeCompare(b.adapter) ||
  a.file.localeCompare(b.file) ||
  a.line - b.line;

function dedupe(degradations) {
  const seen = new Set();
  return degradations.filter((d) => {
    const key = `${d.input}␟${d.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {object} opts
 * @param {string} opts.cwd - analysed repository root.
 * @param {boolean} [opts.probe]
 * @param {string|null} [opts.changedSince]
 * @param {number} [opts.ticketLimit]
 * @param {number} [opts.blameLimit]
 * @param {number} [opts.maxRecords]
 * @param {string} [opts.today] - ISO date (test seam).
 * @param {object} [opts.gh] - gh facade (test seam).
 * @param {Function} [opts.spawn] - probe spawn (test seam).
 * @returns {Promise<object>} the envelope.
 */
export async function runEngine({
  cwd,
  probe = false,
  changedSince = null,
  ticketLimit = DEFAULT_TICKET_LIMIT,
  blameLimit = DEFAULT_BLAME_LIMIT,
  maxRecords = DEFAULT_MAX_RECORDS,
  today = new Date().toISOString().slice(0, 10),
  gh,
  spawn,
}) {
  const root = path.resolve(cwd);
  const scope = buildScope({ root, tempRel: tempRelFor(root) });
  const degradations = [...scope.degradations];
  const ctx = createContext(root, scope, degradations);
  const { adapters, skipped, records } = runAdapters(ctx, degradations);

  const probed = probe
    ? await runProbes(records, { root, scope, spawn })
    : { tools: [], degradations: [] };
  degradations.push(...probed.degradations);
  const tickets = await resolveTicketStates(
    records.flatMap((r) => r.ticketRefs),
    { root, limit: ticketLimit, gh },
  );
  degradations.push(...tickets.degradations);
  classifyAll(records, { ticketStates: tickets.states, today });
  if (changedSince)
    degradations.push(...markIntroduced(records, { root, ref: changedSince }));

  records.sort(byLocation);
  const kept = records.slice(0, maxRecords);
  degradations.push(...addBlame(kept, { root, limit: blameLimit }));

  return {
    kind: ENVELOPE_KIND,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    cwd: root,
    isFrameworkSource: scope.isFrameworkSource,
    options: { probe, changedSince, ticketLimit, blameLimit, maxRecords },
    adapters,
    skipped,
    delegated: delegations(scope),
    probes: probed.tools,
    degradations: dedupe(degradations),
    totals: {
      records: records.length,
      byVerdict: countBy(records, 'verdict', VERDICTS),
      byCategory: countBy(records, 'category', []),
      introduced: records.filter((r) => r.introduced).length,
    },
    clusters: buildClusters(records),
    truncated:
      records.length > maxRecords
        ? { kept: maxRecords, dropped: records.length - maxRecords }
        : null,
    records: kept,
  };
}

/**
 * @param {object} envelope
 * @param {string} outPath
 * @returns {object}
 */
export function summarize(envelope, outPath) {
  return {
    kind: 'audit-exceptions-summary',
    out: outPath,
    records: envelope.totals.records,
    byVerdict: envelope.totals.byVerdict,
    clusters: envelope.clusters.length,
    skipped: envelope.skipped.map((s) => s.id),
    degradations: [...new Set(envelope.degradations.map((d) => d.input))],
    truncated: envelope.truncated,
  };
}
