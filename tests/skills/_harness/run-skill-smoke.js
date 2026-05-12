/**
 * Skill smoke-test harness (Epic #1181 / Story #1441 / Task #1453).
 *
 * One reusable helper — `runSkillSmoke({ skillName, fixture, validator })`
 * — that loads any migrated Skill from `.agents/skills/`, asserts its
 * front-matter declares `name`, `description`, and `allowed_tools`, and
 * runs a caller-provided validator against the parsed Skill plus the
 * fixture path. Used by every per-Skill smoke spec under `tests/skills/`.
 *
 * Why a harness instead of inline duplication: the front-matter contract
 * is shared across every Skill in the framework, and the negative-control
 * acceptance (Tests fail loudly if `allowed_tools` is missing) is easier
 * to keep honest in one place than five.
 *
 * The harness deliberately avoids `js-yaml` — front-matter in this repo is
 * a flat block (`name:`, `description:`, optional `allowed_tools:` list).
 * A tiny purpose-built parser keeps the dependency footprint at zero, and
 * the smoke specs verify the parser by exercising real Skill files.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILLS_ROOTS = [
  path.join(REPO_ROOT, '.agents', 'skills', 'core'),
  path.join(REPO_ROOT, '.agents', 'skills', 'stack'),
];

/**
 * Walk a skills root and return the directory matching `name` (the leaf
 * directory containing `SKILL.md`). Searches one level deep for `core/`
 * and two levels deep for `stack/` (category → name).
 */
async function findSkillDir(skillName) {
  for (const root of SKILLS_ROOTS) {
    let topEntries;
    try {
      topEntries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      const direct = path.join(root, entry.name);
      if (entry.name === skillName) {
        const skillFile = path.join(direct, 'SKILL.md');
        if (await fileExists(skillFile)) return direct;
      }
      // stack/<category>/<name>/SKILL.md
      const nested = await readdir(direct, { withFileTypes: true }).catch(
        () => [],
      );
      for (const sub of nested) {
        if (!sub.isDirectory()) continue;
        if (sub.name !== skillName) continue;
        const nestedDir = path.join(direct, sub.name);
        const skillFile = path.join(nestedDir, 'SKILL.md');
        if (await fileExists(skillFile)) return nestedDir;
      }
    }
  }
  return null;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a SKILL.md file. Returns `{ frontMatter, body }` where
 * `frontMatter` is an object containing scalar fields (`name`,
 * `description`) and any list field (`allowed_tools`) as a JS array.
 *
 * The parser intentionally rejects content that lacks a leading `---`
 * fence — that's exactly the failure the harness needs to surface when a
 * migration is incomplete.
 */
export function parseSkillMarkdown(source) {
  if (typeof source !== 'string') {
    throw new TypeError('parseSkillMarkdown: source must be a string');
  }
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(
      'SKILL.md must start with a YAML front-matter fence ("---" on line 1).',
    );
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error(
      'SKILL.md front-matter fence is unterminated (missing closing "---").',
    );
  }
  const fmBlock = normalized.slice(4, end);
  const body = normalized.slice(end + 5);

  const frontMatter = {};
  const lines = fmBlock.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1];
    const inline = match[2];
    if (inline === '' || inline === '>-' || inline === '>' || inline === '|') {
      // multi-line scalar or list — peek ahead
      const indented = [];
      let listMode = null;
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next === '' || next === undefined) {
          indented.push('');
          i++;
          continue;
        }
        if (/^\s+\S/.test(next)) {
          const trimmed = next.replace(/^\s+/, '');
          if (trimmed.startsWith('- ')) {
            if (listMode === null) listMode = [];
            listMode.push(trimmed.slice(2).trim());
          } else if (listMode === null) {
            indented.push(trimmed);
          } else {
            // mixed — break out, let outer loop re-scan
            break;
          }
          i++;
          continue;
        }
        break;
      }
      if (listMode !== null) {
        frontMatter[key] = listMode;
      } else {
        frontMatter[key] = indented.join(' ').replace(/\s+/g, ' ').trim();
      }
      continue;
    }
    frontMatter[key] = inline.trim();
    i++;
  }

  return { frontMatter, body };
}

/**
 * Run the smoke harness against a single Skill.
 *
 * @param {Object} opts
 * @param {string} opts.skillName        leaf directory name under `.agents/skills/**`
 * @param {string} [opts.fixture]        absolute or repo-relative path passed to the validator
 * @param {Function} [opts.validator]    `async ({ skill, body, fixture }) => void | { ok, errors? }`
 * @param {string[]} [opts.expectedTools] when present, harness asserts these tools are declared in `allowed_tools`
 * @returns {Promise<{ pass: boolean, errors: string[], skill: object, body: string, skillPath: string }>}
 */
export async function runSkillSmoke({
  skillName,
  fixture,
  validator,
  expectedTools,
} = {}) {
  if (!skillName || typeof skillName !== 'string') {
    throw new TypeError('runSkillSmoke: skillName is required (string).');
  }
  const errors = [];

  const skillDir = await findSkillDir(skillName);
  if (!skillDir) {
    return {
      pass: false,
      errors: [
        `Skill "${skillName}" not found under .agents/skills/core or .agents/skills/stack`,
      ],
      skill: null,
      body: null,
      skillPath: null,
    };
  }
  const skillPath = path.join(skillDir, 'SKILL.md');
  const source = await readFile(skillPath, 'utf8');
  let parsed;
  try {
    parsed = parseSkillMarkdown(source);
  } catch (err) {
    return {
      pass: false,
      errors: [`Failed to parse ${skillPath}: ${err.message}`],
      skill: null,
      body: null,
      skillPath,
    };
  }
  const { frontMatter, body } = parsed;

  if (!frontMatter.name || typeof frontMatter.name !== 'string') {
    errors.push(`${skillName}: front-matter is missing "name" field.`);
  } else if (frontMatter.name !== skillName) {
    errors.push(
      `${skillName}: front-matter "name" is "${frontMatter.name}", expected "${skillName}".`,
    );
  }
  if (!frontMatter.description || typeof frontMatter.description !== 'string') {
    errors.push(`${skillName}: front-matter is missing "description" field.`);
  }
  if (!Array.isArray(frontMatter.allowed_tools)) {
    errors.push(
      `${skillName}: front-matter is missing "allowed_tools" list (smoke harness requires it for migrated Skills).`,
    );
  } else if (frontMatter.allowed_tools.length === 0) {
    errors.push(
      `${skillName}: front-matter "allowed_tools" is empty (must declare at least one tool).`,
    );
  }

  if (
    Array.isArray(expectedTools) &&
    Array.isArray(frontMatter.allowed_tools)
  ) {
    const missing = expectedTools.filter(
      (t) => !frontMatter.allowed_tools.includes(t),
    );
    if (missing.length > 0) {
      errors.push(
        `${skillName}: front-matter "allowed_tools" omits required tools: ${missing.join(
          ', ',
        )}`,
      );
    }
  }

  if (typeof validator === 'function' && errors.length === 0) {
    try {
      const result = await validator({
        skill: frontMatter,
        body,
        fixture,
        skillPath,
      });
      if (result && result.ok === false) {
        const more = Array.isArray(result.errors) ? result.errors : [];
        errors.push(
          ...(more.length > 0
            ? more.map((e) => `${skillName}: ${e}`)
            : [`${skillName}: validator reported failure.`]),
        );
      }
    } catch (err) {
      errors.push(`${skillName}: validator threw — ${err.message}`);
    }
  }

  return {
    pass: errors.length === 0,
    errors,
    skill: frontMatter,
    body,
    skillPath,
  };
}

/**
 * Resolve a fixture path relative to the smoke-fixtures root. Spec files
 * pass `fixture: 'epic-1181-sample/epic.md'` and the harness expands it
 * to an absolute path so the validator never depends on `process.cwd()`.
 */
export function fixturePath(...segments) {
  return path.join(__dirname, '..', '_fixtures', ...segments);
}

export const FIXTURES_ROOT = path.join(__dirname, '..', '_fixtures');
export const SKILLS_ROOT_DIRS = SKILLS_ROOTS;
