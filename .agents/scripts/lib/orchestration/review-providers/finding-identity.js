/**
 * review-providers/finding-identity.js — a finding's stable identity across
 * review runs. Line numbers are left out because they move between heads.
 *
 * @typedef {import('./types.js').Finding} Finding
 */

import { createHash } from 'node:crypto';

/**
 * Every location of a finding: its `instances`, else its own `file`/`line`.
 *
 * @param {Finding} finding
 * @returns {{ file: string, line?: number }[]}
 */
export function findingInstances(finding) {
  if (Array.isArray(finding?.instances) && finding.instances.length > 0) {
    return finding.instances;
  }
  if (!finding?.file) return [];
  return Number.isInteger(finding.line)
    ? [{ file: finding.file, line: finding.line }]
    : [{ file: finding.file }];
}

/** @param {unknown} title */
function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First 12 hex chars of sha256 over class (else category), first instance
 * file and, for a class-less finding, its normalized title.
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function findingId(finding) {
  const cls = finding?.class;
  const parts = [
    cls || finding?.category || 'bug',
    findingInstances(finding)[0]?.file ?? '',
    cls ? '' : normalizeTitle(finding?.title),
  ];
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 12);
}
