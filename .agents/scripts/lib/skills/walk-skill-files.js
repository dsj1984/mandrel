// .agents/scripts/lib/skills/walk-skill-files.js
//
// SKILL.md traversal over the payload root and the consumer-writable local
// zone, in deterministic order. The roots stay separately enumerable: the
// shipped skills.index.json is compared byte-for-byte against the package, so
// folding local skills into it would read as payload drift. They are unified
// only at lookup time, by resolveSkillFile.

import fs from 'node:fs';
import path from 'node:path';

const TIERS = Object.freeze(['core', 'stack']);

export const PAYLOAD_SKILLS_SEGMENTS = Object.freeze(['.agents', 'skills']);

/**
 * Inside `.agents/local/`, which sync never touches and drift checks never walk.
 */
export const LOCAL_SKILLS_SEGMENTS = Object.freeze([
  '.agents',
  'local',
  'skills',
]);

/**
 * A tier-relative skill id (`stack/qa/playwright`). Strict because ids become
 * filesystem paths: anything that could escape a root is rejected, not
 * normalized. The config schema imports this as its `pattern` — one regex,
 * two enforcement points.
 */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;

/**
 * @param {string} rootDir
 * @returns {string[]} absolute paths
 */
function walkSkillFiles(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * @param {string[]} files
 * @param {string} repoRoot
 * @returns {string[]}
 */
function sortByRepoRelative(files, repoRoot) {
  return [...files].sort((a, b) => {
    const ra = path.relative(repoRoot, a).split(path.sep).join('/');
    const rb = path.relative(repoRoot, b).split(path.sep).join('/');
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/**
 * @param {string} repoRoot
 * @param {readonly string[]} rootSegments One of the exported segment lists.
 * @returns {string[]} absolute paths
 */
function collectUnderRoot(repoRoot, rootSegments) {
  const skillsRoot = path.join(repoRoot, ...rootSegments);
  const files = TIERS.flatMap((tier) =>
    walkSkillFiles(path.join(skillsRoot, tier)),
  );
  return sortByRepoRelative(files, repoRoot);
}

/**
 * The set the shipped index is generated from — never local-zone skills.
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
export function collectSkillFiles(repoRoot) {
  return collectUnderRoot(repoRoot, PAYLOAD_SKILLS_SEGMENTS);
}

/**
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
export function collectLocalSkillFiles(repoRoot) {
  return collectUnderRoot(repoRoot, LOCAL_SKILLS_SEGMENTS);
}

/**
 * Payload root first, then local (payload wins). Returns rather than throws
 * so the caller names the offending key; `null` (author the skill) and
 * `{ reason: 'invalid-id' }` (fix the id; nothing was searched) need
 * different remedies.
 *
 * @param {string} repoRoot
 * @param {string} skillId Tier-relative id, e.g. `stack/qa/acme-sso`.
 * @returns {{ path: string, root: string } | { reason: 'invalid-id' } | null}
 */
export function resolveSkillFile(repoRoot, skillId) {
  if (typeof skillId !== 'string' || !SKILL_ID_RE.test(skillId)) {
    return { reason: 'invalid-id' };
  }
  for (const segments of [PAYLOAD_SKILLS_SEGMENTS, LOCAL_SKILLS_SEGMENTS]) {
    const candidate = path.join(repoRoot, ...segments, skillId, 'SKILL.md');
    try {
      if (fs.statSync(candidate).isFile()) {
        return { path: candidate, root: segments.join('/') };
      }
    } catch {
      // Absent — try the next root.
    }
  }
  return null;
}

/** POSIX repo-relative roots in search order, for error messages. */
export const SKILL_SEARCH_ROOTS = Object.freeze([
  PAYLOAD_SKILLS_SEGMENTS.join('/'),
  LOCAL_SKILLS_SEGMENTS.join('/'),
]);
