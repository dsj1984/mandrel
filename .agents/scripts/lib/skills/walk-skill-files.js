// .agents/scripts/lib/skills/walk-skill-files.js
//
// Shared traversal for SKILL.md files across the two skills roots:
// the package payload (`.agents/skills/{core,stack}/`) and the
// consumer-writable local zone (`.agents/local/skills/{core,stack}/`).
// Used by validate-skills.js and generate-skills-index.js so both CLIs
// enumerate the same paths in the same deterministic order.
//
// The two roots stay **separately enumerable** on purpose (Story #5135).
// `.agents/skills/skills.index.json` is a committed payload file that
// `mandrel doctor` / `mandrel sync-agents` compare byte-for-byte against
// the installed package; folding a consumer's local skills into it would
// make every consumer's regenerated index read as payload drift and cause
// those commands to refuse. The local zone therefore carries its own
// index artifact, and the two roots are unified only at *lookup* time, by
// `resolveSkillFile` — never for the shipped manifest.

import fs from 'node:fs';
import path from 'node:path';

/** Tier directories a skills root is enumerated under. */
const TIERS = Object.freeze(['core', 'stack']);

/**
 * Path segments (from the repo root) of the package-payload skills root.
 * Materialized by `mandrel sync`; every file under it is payload.
 */
export const PAYLOAD_SKILLS_SEGMENTS = Object.freeze(['.agents', 'skills']);

/**
 * Path segments (from the repo root) of the consumer-writable skills root.
 * It sits inside the `.agents/local/` zone (Story #3498), which sync never
 * copies into and never prunes, and which the agents-drift check cannot
 * flag because that check only walks files present in the package payload.
 */
export const LOCAL_SKILLS_SEGMENTS = Object.freeze([
  '.agents',
  'local',
  'skills',
]);

/**
 * A skill id is the tier-relative path naming a skill — e.g.
 * `core/scope-triage` or `stack/qa/playwright`. It is the value that
 * appears in `skills.index.json` minus the root prefix, and the value a
 * `qa.environments.*.signInSeam.skill` seam carries.
 *
 * The pattern is deliberately strict: ids resolve to filesystem paths, so
 * anything that could escape a root (`..`, absolute paths, backslashes) or
 * smuggle a shell metacharacter is rejected rather than normalized.
 *
 * Exported because `config-settings-schema.js` mirrors it as the `pattern`
 * on `qa.environments.*.signInSeam.skill`, so a malformed id is rejected at
 * config-validation time rather than surviving to a path join (Story #5285).
 * It is one regex with two enforcement points, never two regexes: the AJV
 * `pattern` keyword takes the source string, so the schema must import this
 * value rather than restate it.
 */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;

/**
 * Recursively enumerate `SKILL.md` paths under a directory.
 *
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
 * Sort absolute paths by their POSIX repo-relative form so output order is
 * deterministic across platforms.
 *
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
 * Enumerate the `SKILL.md` files under one skills root, sorted by POSIX
 * repo-relative path.
 *
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
 * Build the list of payload SKILL.md files under
 * `<repoRoot>/.agents/skills/{core,stack}/`.
 *
 * This is the set the **shipped** `skills.index.json` is generated from —
 * it must never include local-zone skills (see the module header).
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
export function collectSkillFiles(repoRoot) {
  return collectUnderRoot(repoRoot, PAYLOAD_SKILLS_SEGMENTS);
}

/**
 * Build the list of consumer-authored SKILL.md files under
 * `<repoRoot>/.agents/local/skills/{core,stack}/`. Empty when the
 * consumer has authored none — the common case, and the case in this
 * repository itself.
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
export function collectLocalSkillFiles(repoRoot) {
  return collectUnderRoot(repoRoot, LOCAL_SKILLS_SEGMENTS);
}

/**
 * Resolve a skill id to a readable `SKILL.md`, searching the payload root
 * first and the local zone second (payload-wins, matching
 * {@link collectAllSkillFiles}).
 *
 * Returns rather than throwing so callers own the error message — a config
 * resolver wants to name the offending config key, a workflow wants to name
 * the seam. The two failures are **distinguishable** (Story #5285):
 *
 *   - `null` — a well-formed id that resolves under neither root. The remedy
 *     is to author the skill, so the caller says so.
 *   - `{ reason: 'invalid-id' }` — an id the pattern rejects (`../../secrets`,
 *     `Core/Foo`, a bare `core`). No filesystem lookup happens, and telling
 *     the operator to author `../../secrets/SKILL.md` would be advice that
 *     cannot be followed. The remedy is to fix the id.
 *
 * @param {string} repoRoot
 * @param {string} skillId Tier-relative id, e.g. `stack/qa/acme-sso`.
 * @returns {{ path: string, root: string } | { reason: 'invalid-id' } | null}
 *   the absolute `SKILL.md` path and the POSIX repo-relative root it resolved
 *   under, the malformed-id marker, or `null` when nothing resolved.
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
      // Unreadable or absent — try the next root.
    }
  }
  return null;
}

/**
 * The POSIX repo-relative skills roots, in search order. Exported so error
 * messages can name exactly what was searched rather than restating the
 * paths as literals.
 */
export const SKILL_SEARCH_ROOTS = Object.freeze([
  PAYLOAD_SKILLS_SEGMENTS.join('/'),
  LOCAL_SKILLS_SEGMENTS.join('/'),
]);
