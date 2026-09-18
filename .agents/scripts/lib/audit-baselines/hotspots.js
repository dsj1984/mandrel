/**
 * Per-file clusters of per-gate outliers. Severity adds across gate
 * memberships before the cost multipliers apply, so convergence (one file bad
 * on several gates) outranks a single membership.
 *
 * @module lib/audit-baselines/hotspots
 */

/**
 * @param {{
 *   outliers: Array<object>,
 *   weightsFor: (id: string) => {
 *     churnWeight: number, centralityWeight: number, frictionWeight: number,
 *   },
 *   limit?: number,
 * }} args
 * @returns {Array<object>} highest rank first
 */
export function buildHotspots({ outliers, weightsFor, limit = 50 }) {
  const clusters = new Map();
  for (const row of outliers) {
    let cluster = clusters.get(row.id);
    if (!cluster) {
      cluster = { path: row.id, gates: [], severityWeight: 0 };
      clusters.set(row.id, cluster);
    }
    cluster.gates.push({
      kind: row.kind,
      metric: row.metric,
      value: row.value,
      rowCount: row.rowCount,
      severityWeight: row.severityWeight,
    });
    cluster.severityWeight += row.severityWeight;
  }

  const ranked = [];
  for (const cluster of clusters.values()) {
    const weights = weightsFor(cluster.path);
    cluster.gates.sort((a, b) => a.kind.localeCompare(b.kind));
    ranked.push({
      path: cluster.path,
      gates: cluster.gates,
      gateKinds: cluster.gates.map((g) => g.kind),
      gateCount: cluster.gates.length,
      severityWeight: cluster.severityWeight,
      ...weights,
      rank:
        cluster.severityWeight *
        weights.churnWeight *
        weights.centralityWeight *
        weights.frictionWeight,
    });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
  return ranked.slice(0, Math.max(0, limit));
}
