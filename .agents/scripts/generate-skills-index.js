#!/usr/bin/env node
// .agents/scripts/generate-skills-index.js
//
// Walk `.agents/skills/{core,stack}/**/SKILL.md` via the shared parser
// helper, project each parsed result into an index entry, and write the
// aggregated manifest to `.agents/skills/skills.index.json`. Supports a
// `--check` mode that compares the on-disk manifest against fresh
// generator output (ignoring the volatile `generatedAt` field) and exits
// non-zero with a diff-style message if they diverge.
//
// CLI surface:
//
//   node generate-skills-index.js [--check] [--root <dir>] [--out <file>]
//
//   --check        Read the on-disk manifest, compare to generator output
//                  modulo `generatedAt`. Exit 0 on match, non-zero on
//                  drift. Does not write.
//   --root <dir>   Use <dir> as the repo root (defaults to the project
//                  root containing `.agents/skills`). Useful for tests
//                  staging fixture trees outside the real repo.
//   --out <file>   Override the manifest output path (defaults to
//                  `<root>/.agents/skills/skills.index.json`).
//
// Honors AGENT_LOG_LEVEL via the shared `Logger`. Stdout is reserved for
// the diff text in --check failure mode; informational progress goes to
// stderr.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { parseSkill } from './lib/skills/parse-skill.js';

const GENERATOR_ID = 'generate-skills-index.js@1';

/**
 * Resolve the default repo root: the directory two levels up from this
 * script (i.e. `<repo>/.agents/scripts/generate-skills-index.js` →
 * `<repo>`).
 */
function defaultRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/**
 * Parse CLI flags. Returns `{ check, root, out }`. Unknown flags trigger
 * a thrown Error so the runAsCli boundary can surface a clean message.
 */
export function parseArgs(argv) {
  const args = { check: false, root: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--check') {
      args.check = true;
      continue;
    }
    if (token === '--root') {
      args.root = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--out') {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`generate-skills-index: unknown argument: ${token}`);
  }
  return args;
}

/**
 * Recursively enumerate `SKILL.md` paths under a directory. Returns an
 * array of absolute paths.
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
 * Build the list of SKILL.md files under <repoRoot>/.agents/skills/{core,
 * stack}/, sorted by POSIX repo-relative path for deterministic output.
 */
function collectSkillFiles(repoRoot) {
  const skillsRoot = path.join(repoRoot, '.agents', 'skills');
  const coreFiles = walkSkillFiles(path.join(skillsRoot, 'core'));
  const stackFiles = walkSkillFiles(path.join(skillsRoot, 'stack'));
  return [...coreFiles, ...stackFiles].sort((a, b) => {
    const ra = path.relative(repoRoot, a).split(path.sep).join('/');
    const rb = path.relative(repoRoot, b).split(path.sep).join('/');
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/**
 * Project a parseSkill result into an index entry shaped by
 * `.agents/schemas/skills-index.schema.json`.
 *
 * For skills that have not yet been backfilled with a Policy Capsule
 * (Wave 1 ships the generator/validator before Wave 2 lands capsules),
 * `policyCapsuleBullets` is emitted as the raw bullet count (which may
 * fall outside the schema's [5, 12] range). The on-disk manifest is
 * regenerated end-state-conformant once capsules land; the validator
 * surfaces missing-capsule findings in the meantime.
 */
function projectEntry(parsed) {
  return {
    name: parsed.name,
    tier: parsed.tier,
    category: parsed.category,
    path: parsed.path,
    description: parsed.frontmatter.description,
    policyCapsuleBullets: parsed.policyCapsule.bulletCount,
    allowedTools: Array.isArray(parsed.frontmatter.allowed_tools)
      ? [...parsed.frontmatter.allowed_tools]
      : null,
    vendor:
      typeof parsed.frontmatter.vendor === 'string'
        ? parsed.frontmatter.vendor
        : null,
  };
}

/**
 * Build the manifest object (without `generatedAt`) by walking the tree
 * and projecting each parsed SKILL.md into an index entry.
 */
export function buildManifestBody(repoRoot) {
  const skillFiles = collectSkillFiles(repoRoot);
  const skills = skillFiles.map((absPath) =>
    projectEntry(parseSkill(absPath, { repoRoot })),
  );
  return {
    generator: GENERATOR_ID,
    skills,
  };
}

/**
 * Build the full manifest with `generatedAt`. `nowIso` is injected so
 * tests can pin the timestamp deterministically.
 */
export function buildManifest(repoRoot, { nowIso } = {}) {
  const body = buildManifestBody(repoRoot);
  return {
    generatedAt: nowIso ?? new Date().toISOString(),
    generator: body.generator,
    skills: body.skills,
  };
}

/**
 * Serialize a manifest object as canonical JSON: 2-space indent,
 * trailing newline. Two runs against an unchanged corpus produce
 * byte-identical output modulo `generatedAt`.
 */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Read the on-disk manifest as a parsed object, or null when missing /
 * unparseable. The --check pipeline distinguishes "missing" (drift) from
 * "unparseable" (drift) via the returned `reason` channel.
 */
function readOnDiskManifest(outPath) {
  if (!fs.existsSync(outPath)) {
    return { manifest: null, reason: 'missing' };
  }
  let src;
  try {
    src = fs.readFileSync(outPath, 'utf8');
  } catch (err) {
    return { manifest: null, reason: `read-error: ${err.message}` };
  }
  try {
    return { manifest: JSON.parse(src), reason: null };
  } catch (err) {
    return { manifest: null, reason: `parse-error: ${err.message}` };
  }
}

/**
 * Compare two manifests ignoring `generatedAt`. Returns null when they
 * match, or a short diff-style message when they diverge.
 */
function diffManifestsIgnoringTimestamp(diskManifest, freshManifest) {
  if (diskManifest === null) {
    return 'on-disk manifest is missing or unreadable';
  }
  const a = { ...diskManifest };
  const b = { ...freshManifest };
  delete a.generatedAt;
  delete b.generatedAt;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) return null;
  // Surface a structural summary rather than a full JSON dump.
  const diskCount = Array.isArray(diskManifest.skills)
    ? diskManifest.skills.length
    : 'n/a';
  const freshCount = Array.isArray(freshManifest.skills)
    ? freshManifest.skills.length
    : 'n/a';
  const summary = [
    'skills.index.json drift detected:',
    `  on-disk entries:  ${diskCount}`,
    `  generated entries: ${freshCount}`,
    "  run 'node .agents/scripts/generate-skills-index.js' to refresh",
  ].join('\n');
  return summary;
}

/**
 * Resolve the manifest output path given (root, optional explicit
 * override).
 */
function resolveOutPath(root, override) {
  return override
    ? path.resolve(override)
    : path.join(root, '.agents', 'skills', 'skills.index.json');
}

/**
 * Pure entry point used by tests. Returns `{ status, output }` where
 * `output` is a stdout string to print (may be empty) and `status` is
 * the exit code.
 */
export function run({ argv = [], now = new Date(), repoRoot } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    return {
      status: 0,
      output: [
        'Usage: generate-skills-index.js [--check] [--root <dir>] [--out <file>]',
      ].join('\n'),
    };
  }
  const root = parsed.root ? path.resolve(parsed.root) : (repoRoot ?? defaultRepoRoot());
  const outPath = resolveOutPath(root, parsed.out);
  const fresh = buildManifest(root, { nowIso: now.toISOString() });

  if (parsed.check) {
    const { manifest: disk, reason } = readOnDiskManifest(outPath);
    if (disk === null) {
      return {
        status: 1,
        output: `skills.index.json drift detected: ${reason}`,
      };
    }
    const diff = diffManifestsIgnoringTimestamp(disk, fresh);
    if (diff === null) {
      Logger.info(`skills.index.json is fresh (${fresh.skills.length} entries)`);
      return { status: 0, output: '' };
    }
    return { status: 1, output: diff };
  }

  const serialized = serializeManifest(fresh);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serialized);
  Logger.info(
    `wrote ${path.relative(root, outPath).split(path.sep).join('/')} (${fresh.skills.length} entries)`,
  );
  return { status: 0, output: '' };
}

async function main() {
  const result = run({ argv: process.argv.slice(2) });
  if (result.output) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.status);
}

runAsCli(import.meta.url, main, { source: 'generate-skills-index' });
