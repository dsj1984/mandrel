#!/usr/bin/env node
// Writes `.agents/skills/skills.index.json` from every payload SKILL.md;
// `--check` compares modulo `generatedAt`. Consumer skills under
// `.agents/local/skills/` get their own index and must never be merged into
// the payload one: doctor/sync-agents compare it byte-for-byte against the
// package and would read a merged index as drift. Stdout is reserved for the
// `--check` diff; progress goes to stderr.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStandardCliArgs } from './lib/cli/standard-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { formatGeneratedJson } from './lib/format-generated-json.js';
import { Logger } from './lib/Logger.js';
import { parseSkill } from './lib/skills/parse-skill.js';
import {
  diffManifests,
  INDEX_FILENAME,
  indexPathFor,
  readManifest,
} from './lib/skills/skills-index.js';
import {
  collectLocalSkillFiles,
  collectSkillFiles,
  LOCAL_SKILLS_SEGMENTS,
  PAYLOAD_SKILLS_SEGMENTS,
} from './lib/skills/walk-skill-files.js';

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

/** Unknown flags throw, for runAsCli to surface. */
export function parseArgs(argv) {
  if (argv.some((t) => t === '--help' || t === '-h')) {
    return { check: false, root: null, out: null, help: true };
  }
  const { values } = parseStandardCliArgs({
    argv,
    extras: {
      check: { type: 'boolean' },
      root: { type: 'string' },
      out: { type: 'string' },
    },
  });
  return { check: values.check, root: values.root, out: values.out };
}

/** `policyCapsuleBullets: 0` means no capsule was found (validator-rejected). */
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

export function buildManifestBody(repoRoot, collect = collectSkillFiles) {
  const skillFiles = collect(repoRoot);
  const skills = skillFiles.map((absPath) =>
    projectEntry(parseSkill(absPath, { repoRoot })),
  );
  return {
    generator: GENERATOR_ID,
    skills,
  };
}

export function buildManifest(repoRoot, { nowIso, collect } = {}) {
  const body = buildManifestBody(repoRoot, collect);
  return {
    generatedAt: nowIso ?? new Date().toISOString(),
    generator: body.generator,
    skills: body.skills,
  };
}

/**
 * Pre-format shape: Biome collapses short arrays this expands, so writes go
 * through `formatGeneratedJson` or the tree is format-dirty on every run.
 */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function resolveOutPath(root, override) {
  return override
    ? path.resolve(override)
    : indexPathFor(root, PAYLOAD_SKILLS_SEGMENTS);
}

/** Not overridable by `--out`, or one run could write both indexes to one file. */
function resolveLocalOutPath(root) {
  return indexPathFor(root, LOCAL_SKILLS_SEGMENTS);
}

function writeManifest(manifest, outPath, root) {
  const serialized = serializeManifest(manifest);
  const opts = { cwd: root, filename: INDEX_FILENAME };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    formatGeneratedJson(serialized, opts) ?? serialized,
  );
}

/** An emptied local zone removes its index rather than leave a stale one. */
function writeLocalManifest(localFresh, localOutPath, root) {
  const rel = path.relative(root, localOutPath).split(path.sep).join('/');
  if (localFresh === null) {
    if (fs.existsSync(localOutPath)) {
      fs.rmSync(localOutPath);
      Logger.info(`removed ${rel} (no local skills remain)`);
    }
    return;
  }
  writeManifest(localFresh, localOutPath, root);
  Logger.info(`wrote ${rel} (${localFresh.skills.length} entries)`);
}

function checkLocalManifest(localFresh, localOutPath) {
  const exists = fs.existsSync(localOutPath);
  if (localFresh === null) {
    return exists
      ? 'local skills.index.json drift detected: the local skills zone is ' +
          'empty but .agents/local/skills/skills.index.json still exists — ' +
          "run 'node .agents/scripts/generate-skills-index.js' to reap it"
      : null;
  }
  if (!exists) {
    return (
      'local skills.index.json drift detected: missing — run ' +
      "'node .agents/scripts/generate-skills-index.js' to write it"
    );
  }
  const { manifest: disk } = readManifest(localOutPath);
  return diffManifests(disk, localFresh, 'local skills.index.json');
}

/**
 * A null `localFresh` signals reaping a stale artifact.
 * @param {string} root
 * @param {Date} now
 * @returns {{ localFresh: object | null, localOutPath: string }}
 */
function buildLocalPlan(root, now) {
  const localOutPath = resolveLocalOutPath(root);
  const localFresh =
    collectLocalSkillFiles(root).length > 0
      ? buildManifest(root, {
          nowIso: now.toISOString(),
          collect: collectLocalSkillFiles,
        })
      : null;
  return { localFresh, localOutPath };
}

/**
 * @param {object} fresh
 * @param {object | null} localFresh
 * @returns {string}
 */
function describeCounts(fresh, localFresh) {
  const base = `${fresh.skills.length} entries`;
  return localFresh === null
    ? base
    : `${base}, ${localFresh.skills.length} local`;
}

/**
 * Reports the first drift found, payload first.
 * @param {{ outPath: string, fresh: object, localOutPath: string, localFresh: object | null }} plan
 * @returns {{ status: number, output: string }}
 */
function checkBothManifests({ outPath, fresh, localOutPath, localFresh }) {
  const { manifest: disk, reason } = readManifest(outPath);
  if (disk === null) {
    return { status: 1, output: `${INDEX_FILENAME} drift detected: ${reason}` };
  }
  const drift =
    diffManifests(disk, fresh, INDEX_FILENAME) ??
    checkLocalManifest(localFresh, localOutPath);
  if (drift !== null) {
    return { status: 1, output: drift };
  }
  Logger.info(
    `${INDEX_FILENAME} is fresh (${describeCounts(fresh, localFresh)})`,
  );
  return { status: 0, output: '' };
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
  const root = parsed.root
    ? path.resolve(parsed.root)
    : (repoRoot ?? defaultRepoRoot());
  const outPath = resolveOutPath(root, parsed.out);
  const fresh = buildManifest(root, { nowIso: now.toISOString() });
  const { localFresh, localOutPath } = buildLocalPlan(root, now);

  if (parsed.check) {
    return checkBothManifests({ outPath, fresh, localOutPath, localFresh });
  }

  writeManifest(fresh, outPath, root);
  Logger.info(
    `wrote ${path.relative(root, outPath).split(path.sep).join('/')} (${fresh.skills.length} entries)`,
  );
  writeLocalManifest(localFresh, localOutPath, root);
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
