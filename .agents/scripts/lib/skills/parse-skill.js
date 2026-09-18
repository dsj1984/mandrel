// .agents/scripts/lib/skills/parse-skill.js
//
// Shared SKILL.md parser (CRLF/LF tolerant) returning
// { path, tier, category, name, frontmatter, policyCapsule }. Throws when
// frontmatter.name differs from the parent directory name.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const FRONTMATTER_DELIMITER = '---';
const POLICY_HEADING_RE = /^## Policy Capsule\s*$/;
const ANY_H2_RE = /^## /;
const BULLET_RE = /^- /;
const CONTINUATION_RE = /^\s+\S/;

/**
 * Nearest ancestor holding `.agents/skills`; fixture trees fall back to four
 * levels up.
 */
function resolveRepoRoot(absoluteSkillPath) {
  let dir = path.dirname(absoluteSkillPath);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.agents', 'skills'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(absoluteSkillPath), '..', '..', '..', '..');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Indices match the file's lines, so 1-based line numbers report verbatim. */
function splitLines(src) {
  return src.split(/\r\n|\n/);
}

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
 * Count top-level `- ` bullets under `## Policy Capsule` up to the next H2.
 * Blank lines and indented (wrapped) continuations stay inside the run; only
 * a flush-left non-bullet line after it terminates — otherwise a wrapped
 * capsule would count as one bullet and trip the validator's floor.
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
      continue;
    }
    if (sawBulletRun && CONTINUATION_RE.test(line)) {
      continue;
    }
    if (sawBulletRun) {
      break;
    }
    // Leading prose before the first bullet is allowed.
  }

  return {
    found: true,
    bulletCount,
    sectionStart: headingIndex + 1, // 1-based
  };
}

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

  // <repo>/.agents/skills/<tier>/<...buckets>/<name>/SKILL.md — core's
  // category is 'core'; stack's is the first bucket under 'stack'.
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
