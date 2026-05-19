/**
 * lib/audit-to-stories/group-findings.js — Cluster findings into Stories.
 *
 * Grouping signals, in priority order (Story #2583):
 *   1. **Same primary file** — two findings on the same file merge.
 *   2. **Adjacent files in the same module directory** — when the
 *      directory hash matches and there is no stronger signal.
 *   3. **Root-cause keyword overlap** — shared topical n-gram across
 *      Current State / Title.
 *
 * Cross-audit grouping is enabled by default: a `security` finding and a
 * `clean-code` finding on the same file produce a single group with both
 * dimensions captured (`group.dimensions` is an array — callers map this
 * to multiple `audit::<dim>` labels).
 *
 * Dependency edges (Recommendation of A references the file Current
 * State of B flags) are emitted as a separate `edges` array — they do
 * NOT merge the groups. The CLI surfaces them in the preview so the
 * operator can decide if a sequencing constraint is worth flagging.
 *
 * Pure: no I/O.
 */

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0, null: -1 };

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

function highestSeverity(findings) {
  let best = null;
  let bestRank = -2;
  for (const f of findings) {
    const r = SEVERITY_RANK[f.severity ?? 'null'] ?? -1;
    if (r > bestRank) {
      bestRank = r;
      best = f.severity ?? null;
    }
  }
  return best;
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
  // Topical tokens drawn from title + current-state.
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
  // A dependency edge fires when group B's primary file is mentioned in
  // group A's Recommendation text (i.e. fixing A requires B to land).
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
 * Cluster findings into Stories.
 *
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
    const primary = pickPrimaryFile(finding);
    let key;

    if (primary) {
      key = `file:${primary}`;
    } else {
      // No file → try signature-based merge with an existing group.
      const { key: matchKey, sig } = bestSignatureGroupKey(finding, sigBuckets);
      if (matchKey) {
        key = matchKey;
      } else {
        key = `topic:${finding.dimension}:${finding.normalisedTitle.slice(0, 40)}`;
        sigBuckets.set(key, sig);
      }
    }

    if (!groups.has(key)) {
      groups.set(key, makeGroup(key));
      if (!sigBuckets.has(key))
        sigBuckets.set(key, rootCauseSignature(finding));
    } else {
      const existing = sigBuckets.get(key) ?? new Set();
      for (const t of rootCauseSignature(finding)) existing.add(t);
      sigBuckets.set(key, existing);
    }

    attachFindingToGroup(groups.get(key), finding);
  }

  // Second pass: merge any single-finding groups whose primary directory
  // matches another group's directory AND whose root-cause signatures
  // overlap by ≥ 3 tokens. This implements signal #2.
  const groupArray = [...groups.values()];
  const merged = new Set();
  for (let i = 0; i < groupArray.length; i += 1) {
    if (merged.has(groupArray[i].groupKey)) continue;
    if (groupArray[i].findings.length > 1) continue;
    const targetDir = dirOf(pickPrimaryFile(groupArray[i].findings[0]) ?? '');
    if (!targetDir) continue;
    const targetSig = sigBuckets.get(groupArray[i].groupKey) ?? new Set();

    for (let j = i + 1; j < groupArray.length; j += 1) {
      if (merged.has(groupArray[j].groupKey)) continue;
      const otherDir = dirOf(
        pickPrimaryFile(groupArray[j].findings[0] ?? {}) ?? '',
      );
      if (otherDir !== targetDir) continue;
      const otherSig = sigBuckets.get(groupArray[j].groupKey) ?? new Set();
      let overlap = 0;
      for (const t of targetSig) if (otherSig.has(t)) overlap += 1;
      if (overlap < 3) continue;

      for (const f of groupArray[j].findings) {
        attachFindingToGroup(groupArray[i], f);
      }
      merged.add(groupArray[j].groupKey);
    }
  }

  const finalGroups = groupArray
    .filter((g) => !merged.has(g.groupKey))
    .map((g) => {
      g.severity = highestSeverity(g.findings);
      g.dimensions = [...g.dimensions].sort();
      g.files = [...g.files];
      g.title = synthesizeTitle(g);
      delete g._signature;
      return g;
    });

  const edges = detectDependencyEdges(finalGroups);

  return { groups: finalGroups, edges };
}
