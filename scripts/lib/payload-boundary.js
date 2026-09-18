/**
 * payload-boundary.js — the ratchet that keeps contributor tooling out of the
 * `.agents/` payload (Story #5381).
 *
 * `mandrel sync` materializes `.agents/` into every consumer checkout, so a
 * CLI that only mandrel's own package.json, CI or hooks ever run costs every
 * consumer bytes and command surface for nothing. Story #5381 moved 24 such
 * CLIs to the repository's root `scripts/`, which is outside the npm `files`
 * array. This module holds the two rules that stop them drifting back:
 *
 *  1. **Every top-level `.agents/scripts/*.js` CLI is named by a consumer
 *     surface.** A consumer surface is anything that runs, or is read, in a
 *     consumer checkout: the workflows, skills, rules, agent files, templates,
 *     docs and `instructions.md` under `.agents/`; the package's `bin/` and
 *     `lib/`; and the payload's own code under `.agents/scripts/` (comment-
 *     stripped, so a CLI spawned or imported by shipped code counts, while a
 *     code comment that merely mentions it does not). `lib/bootstrap/` is part
 *     of that code — it writes script names into a consumer's package.json and
 *     hooks. The CLI's own file never vouches for itself, and
 *     `source-classifier.js`'s basename inventory is a catalogue of every CLI,
 *     not evidence that any one is used.
 *  2. **No file under `.agents/` imports a module outside `.agents/`.** Moved
 *     code may import the payload; the payload must never import moved code,
 *     or a consumer checkout would carry an import that cannot resolve.
 *
 * Pure over an injected `fsImpl` (`docs/contributing/test-seams.md` rule 1),
 * so the suite drives both rules against a planted tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stripJsComments } from '../../.agents/scripts/lib/source-text/strip-js-comments.js';

/** The payload root, repo-relative. */
const PAYLOAD_DIR = '.agents';

/** Top-level CLI directory, repo-relative (POSIX separators). */
const SCRIPTS_DIR = '.agents/scripts';

/**
 * A catalogue that lists every CLI basename by design. Naming a CLI there is
 * not a use of it, so it never counts as a consumer surface.
 */
const CATALOGUE_FILES = new Set([
  '.agents/scripts/lib/observability/source-classifier.js',
]);

/**
 * Consumer surfaces, repo-relative. Every entry is walked recursively.
 *
 * @type {ReadonlyArray<string>}
 */
const CONSUMER_SURFACE_ROOTS = Object.freeze([
  '.agents/workflows',
  '.agents/skills',
  '.agents/rules',
  '.agents/agents',
  '.agents/templates',
  '.agents/docs',
  '.agents/instructions.md',
  '.agents/scripts',
  'bin',
  'lib',
]);

const SOURCE_EXT = /\.(?:m|c)?js$/;
const TEXT_EXT = /\.(?:m|c)?js$|\.(?:md|json|ya?ml|sh|txt|feature)$/;

/**
 * Static and dynamic import / require specifiers. Only relative specifiers can
 * escape the payload, so bare package names are ignored by the caller.
 */
const IMPORT_RE =
  /\bfrom\s*(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)|\brequire\s*\(\s*(['"])([^'"]+)\5\s*\)|^\s*import\s*(['"])([^'"]+)\7/gm;

/**
 * True for a path segment that marks test code, which never ships.
 *
 * @param {string} rel repo-relative POSIX path
 * @returns {boolean}
 */
function isTestPath(rel) {
  return rel.includes('/__tests__/') || /\.test\.[cm]?js$/.test(rel);
}

/**
 * Recursively list files under `root` (a file or a directory), skipping
 * `node_modules`. Returns repo-relative POSIX paths.
 *
 * @param {string} repoRoot absolute
 * @param {string} root repo-relative
 * @param {typeof fs} fsImpl
 * @returns {string[]}
 */
function listFiles(repoRoot, root, fsImpl) {
  const out = [];
  const visit = (rel) => {
    let stat;
    try {
      stat = fsImpl.statSync(path.join(repoRoot, rel));
    } catch {
      return;
    }
    if (!stat.isDirectory()) {
      out.push(rel);
      return;
    }
    for (const name of fsImpl.readdirSync(path.join(repoRoot, rel))) {
      if (name === 'node_modules') continue;
      visit(`${rel}/${name}`);
    }
  };
  visit(root);
  return out.sort();
}

/**
 * The top-level CLI basenames shipped in `.agents/scripts/`.
 *
 * @param {{ repoRoot: string, fsImpl?: typeof fs }} opts
 * @returns {string[]}
 */
function listTopLevelClis({ repoRoot, fsImpl = fs }) {
  let names;
  try {
    names = fsImpl.readdirSync(path.join(repoRoot, SCRIPTS_DIR));
  } catch {
    return [];
  }
  return names
    .filter((name) => SOURCE_EXT.test(name))
    .filter((name) => {
      const stat = fsImpl.statSync(path.join(repoRoot, SCRIPTS_DIR, name));
      return stat.isFile();
    })
    .sort();
}

/**
 * Read every consumer surface. JavaScript arrives comment-stripped.
 *
 * @param {{ repoRoot: string, fsImpl?: typeof fs }} opts
 * @returns {Array<{ path: string, text: string }>}
 */
function collectConsumerSurfaces({ repoRoot, fsImpl = fs }) {
  const surfaces = [];
  for (const root of CONSUMER_SURFACE_ROOTS) {
    for (const rel of listFiles(repoRoot, root, fsImpl)) {
      if (!TEXT_EXT.test(rel) || isTestPath(rel) || CATALOGUE_FILES.has(rel)) {
        continue;
      }
      const raw = fsImpl.readFileSync(path.join(repoRoot, rel), 'utf8');
      surfaces.push({
        path: rel,
        text: SOURCE_EXT.test(rel) ? stripJsComments(raw) : raw,
      });
    }
  }
  return surfaces;
}

/**
 * Rule 1: the top-level CLIs no consumer surface names.
 *
 * A CLI is named when its basename appears as a whole token — not as the tail
 * of a longer name (`my-notify.js` is not `notify.js`). Its own file is
 * excluded, so a CLI cannot vouch for itself.
 *
 * @param {{ clis: string[], surfaces: Array<{ path: string, text: string }> }} input
 * @returns {string[]} sorted basenames
 */
function findUnnamedClis({ clis, surfaces }) {
  return clis.filter((cli) => {
    const own = `${SCRIPTS_DIR}/${cli}`;
    const escaped = cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const token = new RegExp(`(?:^|[^\\w.-])${escaped}(?![\\w-])`);
    return !surfaces.some((s) => s.path !== own && token.test(s.text));
  });
}

/**
 * Rule 2: imports under `.agents/` that resolve outside `.agents/`.
 *
 * @param {{ files: Array<{ path: string, text: string }> }} input
 *   payload source files, comment-stripped
 * @returns {Array<{ file: string, specifier: string }>}
 */
function findEscapingImports({ files }) {
  const escapes = [];
  for (const { path: rel, text } of files) {
    for (const m of text.matchAll(IMPORT_RE)) {
      const specifier = m[2] ?? m[4] ?? m[6] ?? m[8];
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), specifier),
      );
      if (target !== PAYLOAD_DIR && !target.startsWith(`${PAYLOAD_DIR}/`)) {
        escapes.push({ file: rel, specifier });
      }
    }
  }
  return escapes;
}

/**
 * Run both rules against a repository checkout.
 *
 * @param {{ repoRoot: string, fsImpl?: typeof fs }} opts
 * @returns {{ clis: number, unnamed: string[], escapes: Array<{ file: string, specifier: string }> }}
 */
export function checkPayloadBoundary({ repoRoot, fsImpl = fs }) {
  const clis = listTopLevelClis({ repoRoot, fsImpl });
  const surfaces = collectConsumerSurfaces({ repoRoot, fsImpl });
  const payloadSources = listFiles(repoRoot, PAYLOAD_DIR, fsImpl)
    .filter((rel) => SOURCE_EXT.test(rel) && !isTestPath(rel))
    .map((rel) => ({
      path: rel,
      text: stripJsComments(
        fsImpl.readFileSync(path.join(repoRoot, rel), 'utf8'),
      ),
    }));
  return {
    clis: clis.length,
    unnamed: findUnnamedClis({ clis, surfaces }),
    escapes: findEscapingImports({ files: payloadSources }),
  };
}

/**
 * Render a report as text lines.
 *
 * @param {{ clis: number, unnamed: string[], escapes: Array<{ file: string, specifier: string }> }} report
 * @returns {string}
 */
export function renderPayloadBoundaryReport({ clis, unnamed, escapes }) {
  const lines = [];
  for (const cli of unnamed) {
    lines.push(
      `✗ ${SCRIPTS_DIR}/${cli} — named by no consumer surface. If only mandrel's own ` +
        'package.json, CI or hooks run it, move it to scripts/; otherwise cite it ' +
        'where a consumer reaches it.',
    );
  }
  for (const { file, specifier } of escapes) {
    lines.push(
      `✗ ${file} imports ${specifier}, which resolves outside .agents/ — a ` +
        'consumer checkout cannot resolve it.',
    );
  }
  const ok = unnamed.length === 0 && escapes.length === 0;
  lines.push(
    `[payload-boundary] clis=${clis} unnamed=${unnamed.length} ` +
      `escaping-imports=${escapes.length} (${ok ? 'ok' : 'gate fail'})`,
  );
  return `${lines.join('\n')}\n`;
}
