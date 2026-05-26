#!/usr/bin/env node
// .agents/scripts/validate-skills.js
//
// Walk `.agents/skills/{core,stack}/**/SKILL.md` via the shared parser
// helper, validate each frontmatter block against
// `.agents/schemas/skill.schema.json`, enforce Policy Capsule presence
// (5–12 bullets), and verify membership in `.agents/skills/skills.index.json`
// when that manifest exists. All findings are batched into a single
// human-readable report; the process exits non-zero when any finding is
// surfaced.
//
// CLI surface:
//
//   node validate-skills.js [--root <dir>]
//
//   --root <dir>   Use <dir> as the repo root (defaults to the project
//                  root containing `.agents/skills`). Useful for tests
//                  staging fixture trees outside the real repo.
//
// Honors AGENT_LOG_LEVEL via the shared `Logger`. The findings report is
// written to stdout when any finding is present, so callers can capture
// it for ticket comments or CI logs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parseStandardCliArgs } from './lib/cli/standard-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { parseSkill } from './lib/skills/parse-skill.js';
import { collectSkillFiles } from './lib/skills/walk-skill-files.js';

const MIN_CAPSULE_BULLETS = 5;
const MAX_CAPSULE_BULLETS = 12;

function defaultRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

export function parseArgs(argv) {
  // `--help` / `-h` is a side-channel signal handled before the shared
  // parser sees it: the shared parser does not (yet) model help flags as
  // first-class output, and pre-stripping keeps the legacy parsed shape.
  if (argv.some((t) => t === '--help' || t === '-h')) {
    return { root: null, help: true };
  }
  const { values } = parseStandardCliArgs({
    argv,
    extras: { root: { type: 'string' } },
  });
  return { root: values.root };
}

/**
 * Load the skill frontmatter schema from the in-repo schemas directory.
 * Falls back to the script-relative path when the repo root override
 * does not carry its own schema copy (fixture trees reuse the real one).
 */
function loadSkillSchema(repoRoot) {
  const candidate = path.join(
    repoRoot,
    '.agents',
    'schemas',
    'skill.schema.json',
  );
  if (fs.existsSync(candidate)) {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  }
  const fallback = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'schemas',
    'skill.schema.json',
  );
  return JSON.parse(fs.readFileSync(fallback, 'utf8'));
}

function loadManifestSchema(repoRoot) {
  const candidate = path.join(
    repoRoot,
    '.agents',
    'schemas',
    'skills-index.schema.json',
  );
  if (fs.existsSync(candidate)) {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'));
  }
  const fallback = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'schemas',
    'skills-index.schema.json',
  );
  return JSON.parse(fs.readFileSync(fallback, 'utf8'));
}

function createAjv() {
  const AjvCtor = Ajv.default ?? Ajv;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const addFormatsFn = addFormats.default ?? addFormats;
  addFormatsFn(ajv);
  return ajv;
}

function buildValidator(repoRoot) {
  const ajv = createAjv();
  const schema = loadSkillSchema(repoRoot);
  return ajv.compile(schema);
}

function buildManifestValidator(repoRoot) {
  const ajv = createAjv();
  const schema = loadManifestSchema(repoRoot);
  return ajv.compile(schema);
}

/**
 * Read the on-disk skills.index.json manifest, returning `{ exists, paths,
 * manifest }` where `paths` is the Set of `entry.path` values when the file
 * is present and parseable, or null otherwise.
 */
function readIndex(repoRoot) {
  const indexPath = path.join(
    repoRoot,
    '.agents',
    'skills',
    'skills.index.json',
  );
  if (!fs.existsSync(indexPath)) {
    return { exists: false, paths: null, manifest: null, indexPath };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const paths = new Set(
      Array.isArray(manifest.skills)
        ? manifest.skills
            .map((s) => s.path)
            .filter((p) => typeof p === 'string')
        : [],
    );
    return { exists: true, paths, manifest, indexPath };
  } catch (err) {
    return {
      exists: true,
      paths: null,
      manifest: null,
      indexPath,
      parseError: err.message,
    };
  }
}

/**
 * Validate a parsed manifest against skills-index.schema.json. Returns
 * finding strings tagged with the `manifest-schema` pillar.
 */
function validateManifestSchema(manifest, indexRelPath, validateManifest) {
  const findings = [];
  if (!validateManifest(manifest)) {
    for (const err of validateManifest.errors ?? []) {
      const where = err.instancePath || '(root)';
      findings.push(
        `${indexRelPath}: manifest-schema: schema violation at ${where}: ${err.message}`,
      );
    }
  }
  return findings;
}

/**
 * Validate a single SKILL.md. Returns an array of finding strings; an
 * empty array means the file passed every gate.
 */
function validateOne(absPath, repoRoot, validateFrontmatter, indexPaths) {
  const findings = [];
  let parsed;
  try {
    parsed = parseSkill(absPath, { repoRoot });
  } catch (err) {
    findings.push(`${rel(absPath, repoRoot)}: parse error — ${err.message}`);
    return findings;
  }
  if (!validateFrontmatter(parsed.frontmatter)) {
    for (const err of validateFrontmatter.errors ?? []) {
      const where = err.instancePath || '(root)';
      findings.push(
        `${parsed.path}: frontmatter schema violation at ${where}: ${err.message}`,
      );
    }
  }
  if (!parsed.policyCapsule.found) {
    findings.push(`${parsed.path}: missing '## Policy Capsule' section`);
  } else {
    const n = parsed.policyCapsule.bulletCount;
    if (n < MIN_CAPSULE_BULLETS || n > MAX_CAPSULE_BULLETS) {
      findings.push(
        `${parsed.path}: Policy Capsule has ${n} bullet(s); expected between ${MIN_CAPSULE_BULLETS} and ${MAX_CAPSULE_BULLETS}`,
      );
    }
  }
  if (indexPaths && !indexPaths.has(parsed.path)) {
    findings.push(
      `${parsed.path}: missing from .agents/skills/skills.index.json`,
    );
  }
  return findings;
}

function rel(absPath, repoRoot) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

/**
 * Pure entry point used by tests. Returns `{ status, output, findings }`.
 */
export function run({ argv = [], repoRoot } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    return {
      status: 0,
      output: 'Usage: validate-skills.js [--root <dir>]',
      findings: [],
    };
  }
  const root = parsed.root
    ? path.resolve(parsed.root)
    : (repoRoot ?? defaultRepoRoot());
  const validateFrontmatter = buildValidator(root);
  const validateManifest = buildManifestValidator(root);
  const indexInfo = readIndex(root);
  const indexRel = rel(indexInfo.indexPath, root);

  const findings = [];
  if (!indexInfo.exists) {
    findings.push(
      `index missing: ${indexRel} not found — run 'node .agents/scripts/generate-skills-index.js'`,
    );
  } else if (indexInfo.paths === null) {
    findings.push(`index unparseable: ${indexRel} — ${indexInfo.parseError}`);
  } else if (indexInfo.manifest !== null) {
    findings.push(
      ...validateManifestSchema(indexInfo.manifest, indexRel, validateManifest),
    );
  }

  const skillFiles = collectSkillFiles(root);
  const indexPaths =
    indexInfo.exists && indexInfo.paths !== null ? indexInfo.paths : null;
  for (const file of skillFiles) {
    findings.push(...validateOne(file, root, validateFrontmatter, indexPaths));
  }

  if (findings.length === 0) {
    Logger.info(`validate-skills: ${skillFiles.length} skill(s) passed`);
    return { status: 0, output: '', findings };
  }

  const header = `validate-skills: ${findings.length} finding(s) across ${skillFiles.length} skill(s)`;
  const body = findings.map((f) => `  - ${f}`).join('\n');
  return {
    status: 1,
    output: `${header}\n${body}`,
    findings,
  };
}

async function main() {
  const result = run({ argv: process.argv.slice(2) });
  if (result.output) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.status);
}

runAsCli(import.meta.url, main, { source: 'validate-skills' });
