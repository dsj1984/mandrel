/**
 * Cluster findings (across lenses) into Stories by: same primary file, then
 * same directory with root-cause keyword overlap, then keyword overlap alone.
 * Dependency edges (A's recommendation names B's file) are reported
 * separately and never merge groups. Pure.
 */

import { highestSeverity as highestSeverityOf } from '../findings/severity.js';

function dirOf(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return '';
  const norm = filePath.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  return lastSlash === -1 ? '' : norm.slice(0, lastSlash);
}

function pickPrimaryFile(finding) {
  if (Array.isArray(finding?.files) && finding.files.length > 0) {
    return finding.files[0];
  }
  return null;
}

/**
 * `null` (not `info`) when no finding states a severity: absent is not
 * "graded lowest", and callers distinguish them.
 *
 * @param {Array<{ severity?: string }>} findings
 * @returns {string|null} a canonical severity, or null when none is stated.
 */
function highestSeverity(findings) {
  const stated = findings
    .map((f) => f?.severity)
    .filter((value) => typeof value === 'string' && value.length > 0);
  return stated.length === 0 ? null : highestSeverityOf(stated);
}

/**
 * @typedef {object} Group
 * @property {string} groupKey — stable identifier (file path / dir / synthesized).
 * @property {string[]} dimensions — every audit dimension represented.
 * @property {string|null} severity — highest severity in the merge.
 * @property {string[]} files — every file path mentioned across the merge.
 * @property {string} title — synthesized group title.
 * @property {Array<object>} findings — the merged finding objects.
 */

/**
 * @typedef {object} GroupingResult
 * @property {Group[]} groups
 * @property {Array<{ fromGroupKey: string, toGroupKey: string, via: string }>} edges
 */

function tokenisePhrase(text) {
  if (typeof text !== 'string') return new Set();
  return new Set(
    text
      .toLowerCase()
      .replace(/[`*_]/g, '')
      .replace(/[^a-z0-9 -]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4),
  );
}

function rootCauseSignature(finding) {
  const title = tokenisePhrase(finding.normalisedTitle ?? finding.title ?? '');
  const state = tokenisePhrase(finding.currentState ?? '');
  return new Set([...title, ...state]);
}

function bestSignatureGroupKey(finding, sigBuckets) {
  const sig = rootCauseSignature(finding);
  let bestKey = null;
  let bestScore = 0;
  for (const [key, bucket] of sigBuckets.entries()) {
    let overlap = 0;
    for (const t of sig) if (bucket.has(t)) overlap += 1;
    if (overlap > bestScore && overlap >= 3) {
      bestScore = overlap;
      bestKey = key;
    }
  }
  return { key: bestKey, sig };
}

function makeGroup(key) {
  return {
    groupKey: key,
    dimensions: new Set(),
    severity: null,
    files: new Set(),
    title: '',
    findings: [],
    _signature: new Set(),
  };
}

function attachFindingToGroup(group, finding) {
  group.findings.push(finding);
  if (finding.dimension) group.dimensions.add(finding.dimension);
  for (const f of finding.files ?? []) group.files.add(f);
}

function synthesizeTitle(group) {
  const findings = group.findings;
  if (findings.length === 1) return findings[0].title;

  const sharedFile = [...group.files][0];
  const dims = [...group.dimensions].sort();
  if (sharedFile) {
    return `Remediate ${dims.join(' / ')} findings in ${sharedFile}`;
  }
  if (findings.length === 2) {
    return `${findings[0].title} & ${findings[1].title}`;
  }
  return `${findings[0].title} (+${findings.length - 1} related)`;
}

function detectDependencyEdges(groups) {
  // A → B when A's recommendation mentions a file B owns.
  const fileToGroup = new Map();
  for (const g of groups) {
    const filesIter = Array.isArray(g.files) ? g.files : [...g.files];
    for (const f of filesIter) {
      if (!fileToGroup.has(f)) fileToGroup.set(f, g.groupKey);
    }
  }

  const edges = [];
  for (const g of groups) {
    const ownFiles = new Set(Array.isArray(g.files) ? g.files : [...g.files]);
    for (const finding of g.findings) {
      const rec = finding.recommendation ?? '';
      if (!rec) continue;
      for (const [file, owningKey] of fileToGroup.entries()) {
        if (owningKey === g.groupKey) continue;
        if (!ownFiles.has(file) && rec.includes(file)) {
          edges.push({
            fromGroupKey: g.groupKey,
            toGroupKey: owningKey,
            via: file,
          });
        }
      }
    }
  }

  return edges;
}

/**
 * File findings key by primary file; file-less findings join the best
 * signature match or open a new topic key (seeding its signature bucket).
 */
function resolveGroupKey(finding, sigBuckets) {
  const primary = pickPrimaryFile(finding);
  if (primary) return `file:${primary}`;
  const { key: matchKey, sig } = bestSignatureGroupKey(finding, sigBuckets);
  if (matchKey) return matchKey;
  const key = `topic:${finding.dimension}:${finding.normalisedTitle.slice(0, 40)}`;
  sigBuckets.set(key, sig);
  return key;
}

function addFindingToGroups(groups, sigBuckets, key, finding) {
  if (!groups.has(key)) {
    groups.set(key, makeGroup(key));
    if (!sigBuckets.has(key)) sigBuckets.set(key, rootCauseSignature(finding));
  } else {
    const existing = sigBuckets.get(key) ?? new Set();
    for (const t of rootCauseSignature(finding)) existing.add(t);
    sigBuckets.set(key, existing);
  }
  attachFindingToGroup(groups.get(key), finding);
}

function signatureOverlap(a, b) {
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap += 1;
  return overlap;
}

// Merge single-finding groups into a same-directory group sharing ≥ 3
// signature tokens; returns the absorbed keys.
function mergeSameDirectorySingletons(groupArray, sigBuckets) {
  const merged = new Set();
  for (let i = 0; i < groupArray.length; i += 1) {
    const target = groupArray[i];
    if (merged.has(target.groupKey) || target.findings.length > 1) continue;
    const targetDir = dirOf(pickPrimaryFile(target.findings[0]) ?? '');
    if (!targetDir) continue;
    const targetSig = sigBuckets.get(target.groupKey) ?? new Set();

    for (let j = i + 1; j < groupArray.length; j += 1) {
      const other = groupArray[j];
      if (merged.has(other.groupKey)) continue;
      const otherDir = dirOf(pickPrimaryFile(other.findings[0] ?? {}) ?? '');
      if (otherDir !== targetDir) continue;
      const otherSig = sigBuckets.get(other.groupKey) ?? new Set();
      if (signatureOverlap(targetSig, otherSig) < 3) continue;

      for (const f of other.findings) attachFindingToGroup(target, f);
      merged.add(other.groupKey);
    }
  }
  return merged;
}

function finalizeGroup(g) {
  g.severity = highestSeverity(g.findings);
  g.dimensions = [...g.dimensions].sort();
  g.files = [...g.files];
  g.title = synthesizeTitle(g);
  delete g._signature;
  return g;
}

/**
 * @param {Array<{
 *   dimension: string,
 *   severity: string|null,
 *   title: string,
 *   normalisedTitle: string,
 *   files: string[],
 *   currentState: string,
 *   recommendation: string,
 * }>} findings
 * @returns {GroupingResult}
 */
export function groupFindings(findings) {
  if (!Array.isArray(findings)) {
    throw new Error('groupFindings: findings must be an array');
  }

  const groups = new Map();
  const sigBuckets = new Map();
  for (const finding of findings) {
    addFindingToGroups(
      groups,
      sigBuckets,
      resolveGroupKey(finding, sigBuckets),
      finding,
    );
  }

  const groupArray = [...groups.values()];
  const merged = mergeSameDirectorySingletons(groupArray, sigBuckets);
  const finalGroups = groupArray
    .filter((g) => !merged.has(g.groupKey))
    .map(finalizeGroup);

  return { groups: finalGroups, edges: detectDependencyEdges(finalGroups) };
}
