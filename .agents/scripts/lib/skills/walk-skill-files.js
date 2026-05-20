// .agents/scripts/lib/skills/walk-skill-files.js
//
// Shared traversal for SKILL.md files under `.agents/skills/{core,stack}/`.
// Used by validate-skills.js and generate-skills-index.js so both CLIs
// enumerate the same paths in the same deterministic order.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively enumerate `SKILL.md` paths under a directory.
 *
 * @param {string} rootDir
 * @returns {string[]} absolute paths
 */
export function walkSkillFiles(rootDir) {
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
 * Build the list of SKILL.md files under `<repoRoot>/.agents/skills/{core,
 * stack}/`, sorted by POSIX repo-relative path for deterministic output.
 *
 * @param {string} repoRoot
 * @returns {string[]} absolute paths
 */
export function collectSkillFiles(repoRoot) {
  const skillsRoot = path.join(repoRoot, '.agents', 'skills');
  const coreFiles = walkSkillFiles(path.join(skillsRoot, 'core'));
  const stackFiles = walkSkillFiles(path.join(skillsRoot, 'stack'));
  return [...coreFiles, ...stackFiles].sort((a, b) => {
    const ra = path.relative(repoRoot, a).split(path.sep).join('/');
    const rb = path.relative(repoRoot, b).split(path.sep).join('/');
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}
