/**
 * Assembles the `/audit-baselines` evidence envelope. Read-only and offline:
 * never writes baselines or runs a suite — a review costs a file read, not a
 * CI run. Evidence, not a verdict: assembling it is success (exit 0).
 *
 * @module lib/audit-baselines/engine
 */

import path from 'node:path';
import { mainCheckoutRoot, tempRootFrom } from '../config/temp-paths.js';
import { getQuality, resolveConfig } from '../config-resolver.js';
import { buildGateSurface } from './gate-surface.js';
import { buildHeadroom } from './headroom.js';
import { buildHotspots } from './hotspots.js';
import { ALL_KINDS, baselinePathFor, GATE_KINDS } from './kinds.js';
import { DEFAULT_TOP_N, extractOutliers } from './outliers.js';
import { buildTrend } from './trend.js';
import {
  makeWeightResolver,
  readCentrality,
  readChurn,
  readFriction,
} from './weights.js';

/** Matches the shipped schema's const. */
const ENVELOPE_KIND = 'audit-baselines-envelope';

/** Bump on any breaking shape change. */
const ENVELOPE_SCHEMA_VERSION = '1';

export const DEFAULT_HOTSPOT_LIMIT = 50;

/**
 * A broken `.agentrc.json` must not abort: default baseline paths still read.
 *
 * @param {string} cwd
 * @returns {{ quality: object, configError: string | null }}
 */
function resolveQualityBlock(cwd) {
  try {
    return { quality: getQuality(resolveConfig({ cwd })), configError: null };
  } catch (err) {
    return { quality: { gates: {} }, configError: err?.message ?? String(err) };
  }
}

/**
 * Anchored to the analysed repo (`--cwd`), not the process's checkout as
 * `resolvedTempRoot()` would be.
 *
 * @param {string} cwd
 * @returns {string}
 */
function tempRootFor(cwd) {
  let relative = 'temp';
  try {
    relative = tempRootFrom(resolveConfig({ cwd }));
  } catch {
    // Unreadable config: probe the default root.
  }
  if (path.isAbsolute(relative)) return relative;
  return path.join(mainCheckoutRoot(cwd) ?? cwd, relative);
}

/**
 * @param {{
 *   cwd: string,
 *   topN?: number,
 *   hotspotLimit?: number,
 *   trendDepth?: number,
 *   now?: Date,
 * }} args
 * @returns {object} the `audit-baselines-envelope`
 */
export function runEngine({
  cwd,
  topN = DEFAULT_TOP_N,
  hotspotLimit = DEFAULT_HOTSPOT_LIMIT,
  trendDepth = 5,
  now = new Date(),
}) {
  const { quality, configError } = resolveQualityBlock(cwd);
  const { entries, baselines } = buildGateSurface({ cwd, quality, now });

  const outliers = ALL_KINDS.flatMap((kind) =>
    extractOutliers({ kind, baseline: baselines.get(kind) ?? null, topN }),
  );

  const churn = readChurn({ cwd });
  const centrality = readCentrality({ cwd });
  const friction = readFriction({ tempRootAbs: tempRootFor(cwd) });

  return {
    kind: ENVELOPE_KIND,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    cwd,
    topN,
    configError,
    degradations: {
      gitHistory: churn.degraded,
      importGraph: centrality.degraded,
      frictionLedger: friction.degraded,
    },
    gateSurface: entries,
    hotspots: buildHotspots({
      outliers,
      weightsFor: makeWeightResolver({ churn, centrality, friction }),
      limit: hotspotLimit,
    }),
    trend: buildTrend({
      cwd,
      kinds: ALL_KINDS,
      pathFor: (kind) => baselinePathFor(kind, quality),
      depth: trendDepth,
    }),
    headroom: buildHeadroom({ kinds: GATE_KINDS, quality, baselines }),
  };
}

/**
 * Terminal-sized stdout summary; never carries a row set.
 *
 * @param {object} envelope
 * @param {string} outPath
 * @returns {object}
 */
export function summarize(envelope, outPath) {
  return {
    kind: 'audit-baselines-summary',
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    out: outPath,
    generatedAt: envelope.generatedAt,
    gateSurface: {
      total: envelope.gateSurface.length,
      configured: envelope.gateSurface.filter((g) => g.configured).length,
      missingBaseline: envelope.gateSurface
        .filter((g) => !g.baselineExists)
        .map((g) => g.kind),
      stubs: envelope.gateSurface.filter((g) => g.stub).map((g) => g.kind),
      deadIgnoreGlobs: envelope.gateSurface.reduce(
        (n, g) => n + g.deadIgnoreGlobs.length,
        0,
      ),
    },
    hotspots: {
      total: envelope.hotspots.length,
      multiGate: envelope.hotspots.filter((h) => h.gateCount > 1).length,
      top: envelope.hotspots
        .slice(0, 5)
        .map((h) => ({ path: h.path, gates: h.gateKinds, rank: h.rank })),
    },
    trend: { kinds: envelope.trend.length },
    headroom: { axes: envelope.headroom.length },
    degradations: envelope.degradations,
  };
}
