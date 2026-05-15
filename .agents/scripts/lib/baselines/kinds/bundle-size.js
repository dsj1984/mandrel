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
