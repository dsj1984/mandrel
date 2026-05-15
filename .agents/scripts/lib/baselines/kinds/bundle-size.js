/**
 * kinds/bundle-size.js — per-kind module for the bundle-size baseline
 * (Story #1891). Row shape: `{ bundle, rawKb, gzippedKb }`. Bundle names
 * are opaque identifiers (`main`, `vendor`, etc.) rather than file paths,
 * so they bypass the canonicaliser.
 */

export const name = 'bundle-size';
export const keyField = 'bundle';
const KERNEL_VERSION = '1.0.0';

export function kernelVersion() {
  return KERNEL_VERSION;
}

export function projectRow(row) {
  if (typeof row.bundle !== 'string' || row.bundle.length === 0) {
    throw new Error(
      `kinds/bundle-size.projectRow: bundle name must be a non-empty string (got ${JSON.stringify(row.bundle)})`,
    );
  }
  return {
    bundle: row.bundle,
    rawKb: Number(row.rawKb),
    gzippedKb: Number(row.gzippedKb),
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => a.bundle.localeCompare(b.bundle));
}

function aggregate(rows) {
  if (!rows || rows.length === 0) return { totalKb: 0, gzippedKb: 0 };
  let totalKb = 0;
  let gzippedKb = 0;
  for (const r of rows) {
    totalKb += r.rawKb ?? 0;
    gzippedKb += r.gzippedKb ?? 0;
  }
  return {
    totalKb: Number(totalKb.toFixed(2)),
    gzippedKb: Number(gzippedKb.toFixed(2)),
  };
}

/**
 * Pure compare(head, base) for the bundle-size kind. Diffs rows by
 * `bundle`. A row regresses when rawKb or gzippedKb increases; improves
 * when either decreases without the other increasing; otherwise
 * unchanged. New bundles count as regressions when they carry any size;
 * removed bundles count as improvements when they had any size.
 *
 * No I/O. No process exit. No friction emission.
 */
export function compare(head, base) {
  const headRows = Array.isArray(head?.rows) ? head.rows : [];
  const baseRows = Array.isArray(base?.rows) ? base.rows : [];
  const baseByKey = new Map();
  for (const r of baseRows) baseByKey.set(r.bundle, r);
  const seen = new Set();
  const regressions = [];
  const improvements = [];
  const unchanged = [];
  for (const h of headRows) {
    seen.add(h.bundle);
    const b = baseByKey.get(h.bundle);
    if (!b) {
      const total = (h.rawKb ?? 0) + (h.gzippedKb ?? 0);
      if (total > 0) regressions.push({ key: h.bundle, head: h, base: null });
      else unchanged.push({ key: h.bundle, head: h, base: null });
      continue;
    }
    const rawDelta = (h.rawKb ?? 0) - (b.rawKb ?? 0);
    const gzDelta = (h.gzippedKb ?? 0) - (b.gzippedKb ?? 0);
    if (rawDelta > 0 || gzDelta > 0) {
      regressions.push({ key: h.bundle, head: h, base: b });
    } else if (rawDelta < 0 || gzDelta < 0) {
      improvements.push({ key: h.bundle, head: h, base: b });
    } else {
      unchanged.push({ key: h.bundle, head: h, base: b });
    }
  }
  for (const b of baseRows) {
    if (seen.has(b.bundle)) continue;
    const total = (b.rawKb ?? 0) + (b.gzippedKb ?? 0);
    if (total > 0) improvements.push({ key: b.bundle, head: null, base: b });
    else unchanged.push({ key: b.bundle, head: null, base: b });
  }
  return { regressions, improvements, unchanged };
}

export function rollup(rows, components = []) {
  const out = { '*': aggregate(rows) };
  for (const c of components ?? []) {
    const matched = (rows ?? []).filter(
      (r) => Array.isArray(c.bundles) && c.bundles.includes(r.bundle),
    );
    out[c.name] = aggregate(matched);
  }
  return out;
}
