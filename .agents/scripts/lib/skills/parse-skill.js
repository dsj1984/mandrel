// .agents/scripts/lib/skills/parse-skill.js
//
// Shared SKILL.md parser used by the skills index generator and the skills
// validator. Pure I/O on top of a single fs.readFileSync — no network, no
// child processes, no env reads. Tolerant of CRLF and LF line endings.
//
// Public API:
//
//   parseSkill(absolutePath, options?) -> {
//     path,            // repo-relative POSIX path (string)
//     tier,            // 'core' | 'stack'
//     category,        // bucket directly under the tier (string)
//     name,            // parent directory name of SKILL.md (string)
//     frontmatter,     // YAML-parsed object from between the leading '---' markers
//     policyCapsule: {
//       found,         // boolean — true iff a '## Policy Capsule' heading exists
//       bulletCount,   // integer — count of contiguous top-level '- ' bullets
//       sectionStart,  // 1-based line number of the heading (null when absent)
//     },
//   }
//
// The parser asserts that frontmatter.name equals the parent directory name
// and throws a descriptive Error when the two diverge.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const FRONTMATTER_DELIMITER = '---';
const POLICY_HEADING_RE = /^## Policy Capsule\s*$/;
const ANY_H2_RE = /^## /;
const BULLET_RE = /^- /;

/**
 * Repo root resolver. Walks up from the SKILL.md path until we find a
 * directory that contains an `.agents/skills` folder — that's the canonical
 * marker. Falls back to the file's grandparent's grandparent if no marker
 * is found, which is good enough for tests using temp fixtures.
 */
function resolveRepoRoot(absoluteSkillPath) {
  let dir = path.dirname(absoluteSkillPath);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.agents', 'skills'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback for fixture trees rooted outside a real .agents layout.
  return path.resolve(path.dirname(absoluteSkillPath), '..', '..', '..', '..');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Split the source on either CRLF or LF without normalizing line endings.
 * The returned array's length and indices match the original file's line
 * count, which lets callers report 1-based line numbers verbatim.
 */
function splitLines(src) {
  return src.split(/\r\n|\n/);
}

/**
 * Extract the YAML frontmatter block sitting between the first two '---'
 * lines. Throws when the file lacks a leading delimiter or never closes it.
 */
function extractFrontmatterBlock(lines, skillPath) {
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    throw new Error(
      `SKILL.md is missing the leading '---' frontmatter delimiter: ${skillPath}`,
    );
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      return { yamlText: lines.slice(1, i).join('\n'), bodyStart: i + 1 };
    }
  }
  throw new Error(
    `SKILL.md frontmatter is not closed by a trailing '---': ${skillPath}`,
  );
}

/**
 * Scan the body for the '## Policy Capsule' heading and count contiguous
 * top-level '- ' bullets that follow it, stopping at the next '## ' heading
 * or end-of-file. Blank lines inside the bullet run do not reset the count;
 * a non-bullet, non-blank line does.
 */
function findPolicyCapsule(lines, bodyStart) {
  let headingIndex = -1;
  for (let i = bodyStart; i < lines.length; i += 1) {
    if (POLICY_HEADING_RE.test(lines[i])) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) {
    return { found: false, bulletCount: 0, sectionStart: null };
  }

  let bulletCount = 0;
  let sawBulletRun = false;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (ANY_H2_RE.test(line)) break;
    if (BULLET_RE.test(line)) {
      bulletCount += 1;
      sawBulletRun = true;
      continue;
    }
    if (line.trim() === '') {
      // Blank lines inside or before the bullet run are tolerated.
      continue;
    }
    if (sawBulletRun) {
      // Non-blank, non-bullet line after the bullet run terminates it.
      break;
    }
    // Leading prose between heading and the first bullet is allowed.
  }

  return {
    found: true,
    bulletCount,
    sectionStart: headingIndex + 1, // 1-based
  };
}

/**
 * Parse a SKILL.md file. See module-level docstring for the return shape.
 */
export function parseSkill(absolutePath, options = {}) {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    throw new TypeError('parseSkill: absolutePath must be a non-empty string');
  }
  if (!path.isAbsolute(absolutePath)) {
    throw new TypeError(
      `parseSkill: absolutePath must be absolute (got ${absolutePath})`,
    );
  }

  const repoRoot = options.repoRoot ?? resolveRepoRoot(absolutePath);
  const src = fs.readFileSync(absolutePath, 'utf8');
  const lines = splitLines(src);

  const { yamlText, bodyStart } = extractFrontmatterBlock(lines, absolutePath);

  let frontmatter;
  try {
    frontmatter = yaml.load(yamlText);
  } catch (err) {
    throw new Error(
      `SKILL.md frontmatter is not valid YAML at ${absolutePath}: ${err.message}`,
    );
  }
  if (
    frontmatter === null ||
    typeof frontmatter !== 'object' ||
    Array.isArray(frontmatter)
  ) {
    throw new Error(
      `SKILL.md frontmatter must be a YAML mapping at ${absolutePath}`,
    );
  }

  const parentDir = path.dirname(absolutePath);
  const dirName = path.basename(parentDir);

  if (frontmatter.name !== dirName) {
    throw new Error(
      `SKILL.md frontmatter.name (${JSON.stringify(frontmatter.name)}) does not match parent directory name (${JSON.stringify(dirName)}) at ${absolutePath}`,
    );
  }

  // Derive tier / category from the path. Layout is:
  //   <repo>/.agents/skills/<tier>/<...buckets>/<name>/SKILL.md
  // For core skills the bucket is the literal 'core' (one level deep);
  // for stack skills the bucket is the first segment under 'stack'
  // (e.g. 'backend', 'frontend', 'qa').
  const relPath = toPosix(path.relative(repoRoot, absolutePath));
  const parts = relPath.split('/');
  const skillsIdx = parts.indexOf('skills');
  let tier = null;
  let category = null;
  if (skillsIdx >= 0 && parts.length >= skillsIdx + 4) {
    tier = parts[skillsIdx + 1];
    category = tier === 'core' ? 'core' : parts[skillsIdx + 2];
  }

  const policyCapsule = findPolicyCapsule(lines, bodyStart);

  return {
    path: relPath,
    tier,
    category,
    name: dirName,
    frontmatter,
    policyCapsule,
  };
}
