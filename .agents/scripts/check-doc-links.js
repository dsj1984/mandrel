#!/usr/bin/env node

// Resolves relative Markdown links and `/slash-command` tokens across active
// docs (anchors stripped, not validated), rejects retired commands even when a
// stale workflow file exists, and rejects `.agents/**` links that escape the
// materialized payload.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import { parseStandardCliArgs } from './lib/cli/standard-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Stored without the leading slash, as are the sets below.
export const RETIRED_COMMANDS = new Set([
  'agents-bootstrap-github',
  'single-story-plan',
  'mandrel',
  'explain',
  'git-merge-pr',
]);

// Old command names a historical record (an ADR) may still quote, scoped
// per-file and per-token so a typo elsewhere still fails.
export const SUPERSEDED_COMMAND_SPELLINGS = new Map([
  ['docs/decisions.md', new Set(['plan', 'deliver'])],
]);

// `/foo` tokens in prose that are path roots or URL fragments, not commands.
export const SLASH_ALLOWLIST = new Set([
  'temp',
  'dev',
  'tmp',
  'var',
  'etc',
  'usr',
  'opt',
  'home',
  'root',
  'mnt',
  'srv',
  'bin',
  'sbin',
  'proc',
  'sys',
  'c',
  'issues',
  'pull',
  'pulls',
  'blob',
  'tree',
  'commit',
  'commits',
  'compare',
  'releases',
  'actions',
  'wiki',
  'settings',
  'repos',
  'orgs',
  'users',
  'api',
  'raw',
  'archive',
  'discussions',
  'labels',
  'milestones',
  'projects',
  'tags',
  'docs',
  'guide',
  'reference',
  'search',
  'login',
  'logout',
  'admin',
  'static',
  'assets',
  'images',
  'public',
  'src',
  'lib',
  'node_modules',
  'workflows',
  'features',
  'main',
]);

// `mandrel sync` materializes only `.agents/` into a consumer (`bin/`, `lib/`
// stay in node_modules; tests/docs ship nowhere), so a link escaping it
// resolves here yet dangles for every consumer — existence alone can't catch it.
export const MATERIALIZED_ROOT = '.agents';

// Consumer-owned paths outside `.agents/`, listed explicitly so a new escaping
// link fails closed until justified here.
export const CONSUMER_OWNED_PATHS = new Set([
  'package.json',
  '.agentrc.json',
  '.c8rc.cjs',
  'docs/architecture.md',
  'docs/decisions.md',
]);

export const CONSUMER_OWNED_PREFIXES = Object.freeze(['baselines/']);

/**
 * Only links whose source is under `.agents/**` are subject to the rule.
 * @param {string} relFile
 * @param {string} relTarget
 */
export function escapesPayload(relFile, relTarget) {
  if (!relFile.startsWith(`${MATERIALIZED_ROOT}/`)) return false;
  if (
    relTarget === MATERIALIZED_ROOT ||
    relTarget.startsWith(`${MATERIALIZED_ROOT}/`)
  ) {
    return false;
  }
  if (CONSUMER_OWNED_PATHS.has(relTarget)) return false;
  if (CONSUMER_OWNED_PREFIXES.some((p) => relTarget.startsWith(p)))
    return false;
  return true;
}

function isExcludedRelPath(relPath) {
  if (relPath === 'docs/CHANGELOG.md') return true;
  return false;
}

function walkMarkdown(dirAbs, repoRoot, out) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkMarkdown(abs, repoRoot, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (!isExcludedRelPath(rel)) out.push(abs);
    }
  }
}

/**
 * @param {string}   rootAbs
 * @param {string[]} scanRoots
 * @param {string[]} [exclude] minimatch globs over repo-relative POSIX paths
 */
export function discoverMarkdown(rootAbs, scanRoots, exclude = []) {
  const out = [];
  for (const sub of scanRoots) {
    const subAbs = path.join(rootAbs, sub);
    if (fs.existsSync(subAbs)) walkMarkdown(subAbs, rootAbs, out);
  }
  const filtered = exclude.length
    ? out.filter((abs) => {
        const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
        return !exclude.some((g) => minimatch(rel, g, { dot: true }));
      })
    : out;
  filtered.sort();
  return filtered;
}

// Blanks fenced blocks and inline code spans, preserving newlines so line
// numbers stay aligned; a closing fence must match its opener's marker.
export function maskCodeRegions(source) {
  const lines = source.split('\n');
  const out = new Array(lines.length);
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
    if (inFence) {
      out[i] = '';
      if (
        fenceMatch?.[2].startsWith(fenceMarker[0]) &&
        fenceMatch[2].length >= fenceMarker.length
      ) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (fenceMatch) {
      inFence = true;
      fenceMarker = fenceMatch[2];
      out[i] = '';
      continue;
    }
    out[i] = line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  }
  return out.join('\n');
}

function offsetToLine(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

// Inline links only; reference-style links are out of scope.
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

export function extractLinks(masked) {
  const out = [];
  LINK_RE.lastIndex = 0;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = LINK_RE.exec(masked)) !== null) {
    out.push({
      target: m[2],
      line: offsetToLine(masked, m.index),
    });
  }
  return out;
}

function isExternalOrInternalAnchor(target) {
  if (target.startsWith('#')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true; // http:, https:, mailto:, etc.
  if (target.startsWith('//')) return true; // protocol-relative
  return false;
}

function stripAnchorAndQuery(target) {
  let t = target;
  const hash = t.indexOf('#');
  if (hash !== -1) t = t.slice(0, hash);
  const q = t.indexOf('?');
  if (q !== -1) t = t.slice(0, q);
  return t;
}

// The filesystem knows only decoded names (`%5Btoken%5D` → `[token]`); a
// malformed escape falls back to the raw string instead of throwing.
function decodeLinkPath(pathOnly) {
  if (!pathOnly.includes('%')) return pathOnly;
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    return pathOnly;
  }
}

// The lookbehind rejects path segments (`run-<id>/x`, `run-[ID]/x`, URLs);
// the lookahead rejects extensions and prefixes. The optional `:name` tail
// captures namespaced `/loops:<name>` commands.
const SLASH_TOKEN_RE =
  /(?<![\w/:.>\])])\/([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)(?![\w.-])/g;

export function extractSlashTokens(masked) {
  const out = [];
  SLASH_TOKEN_RE.lastIndex = 0;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = SLASH_TOKEN_RE.exec(masked)) !== null) {
    out.push({
      token: m[1],
      line: offsetToLine(masked, m.index),
    });
  }
  return out;
}

/**
 * @param {string} relFile
 * @returns {Set<string>}
 */
function slashAllowlistFor(relFile) {
  const superseded = SUPERSEDED_COMMAND_SPELLINGS.get(relFile);
  if (!superseded) return SLASH_ALLOWLIST;
  return new Set([...SLASH_ALLOWLIST, ...superseded]);
}

export function checkFile(absPath, repoRoot) {
  const violations = [];
  const source = fs.readFileSync(absPath, 'utf8');
  const masked = maskCodeRegions(source);
  const fileDir = path.dirname(absPath);
  const relFile = path.relative(repoRoot, absPath).split(path.sep).join('/');
  const workflowsDir = path.join(repoRoot, '.agents', 'workflows');

  const slashTokens = extractSlashTokens(masked);

  // Retired commands win over the allowlist and over resolution.
  for (const { token, line } of slashTokens) {
    if (RETIRED_COMMANDS.has(token)) {
      violations.push({
        file: relFile,
        line,
        kind: 'retired-command',
        message: `retired slash command /${token} is not allowed in active docs`,
      });
    }
  }

  for (const { target, line } of extractLinks(masked)) {
    if (isExternalOrInternalAnchor(target)) continue;
    const rawPathOnly = stripAnchorAndQuery(target);
    if (!rawPathOnly) continue;
    // Decode after stripping, so an escaped `%23` cannot become an anchor.
    const pathOnly = decodeLinkPath(rawPathOnly);
    let resolved;
    if (pathOnly.startsWith('/')) {
      resolved = path.join(repoRoot, pathOnly);
    } else {
      resolved = path.resolve(fileDir, pathOnly);
    }
    // Boundary wins over existence; one link reports one kind.
    const relTarget = path
      .relative(repoRoot, resolved)
      .split(path.sep)
      .join('/');
    if (escapesPayload(relFile, relTarget)) {
      violations.push({
        file: relFile,
        line,
        kind: 'payload-boundary',
        message:
          `link escapes the materialized payload: ${target} → ${relTarget}. ` +
          `Only '${MATERIALIZED_ROOT}/' is materialized into a consumer project, ` +
          'so this resolves here but dangles for every consumer. Use an absolute ' +
          'GitHub URL or a non-link code span.',
      });
      continue;
    }
    if (!fs.existsSync(resolved)) {
      violations.push({
        file: relFile,
        line,
        kind: 'broken-link',
        message: `broken relative link: ${target}`,
      });
    }
  }

  // A helpers/ module is a valid command target too.
  const slashAllowlist = slashAllowlistFor(relFile);
  for (const { token, line } of slashTokens) {
    if (RETIRED_COMMANDS.has(token)) continue;
    if (slashAllowlist.has(token)) continue;
    if (token.includes(':')) {
      const [ns, name] = token.split(':');
      const nsFile = path.join(workflowsDir, ns, `${name}.md`);
      if (!fs.existsSync(nsFile)) {
        violations.push({
          file: relFile,
          line,
          kind: 'unknown-command',
          message: `slash command /${token} does not resolve to .agents/workflows/${ns}/${name}.md`,
        });
      }
      continue;
    }
    const workflowFile = path.join(workflowsDir, `${token}.md`);
    const helperFile = path.join(workflowsDir, 'helpers', `${token}.md`);
    if (!fs.existsSync(workflowFile) && !fs.existsSync(helperFile)) {
      violations.push({
        file: relFile,
        line,
        kind: 'unknown-command',
        message: `slash command /${token} does not resolve to .agents/workflows/${token}.md`,
      });
    }
  }

  return violations;
}

export const DEFAULT_SCAN_ROOTS = Object.freeze(['docs', '.agents']);

/**
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {string[]} [options.scanRoots]
 * @param {string[]} [options.exclude]
 */
export function runCheck(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const scanRoots = options.scanRoots ?? [...DEFAULT_SCAN_ROOTS];
  const exclude = options.exclude ?? [];
  const files = discoverMarkdown(repoRoot, scanRoots, exclude);
  const violations = [];
  for (const abs of files) {
    const fileViolations = checkFile(abs, repoRoot);
    violations.push(...fileViolations);
  }
  return {
    exitCode: violations.length === 0 ? 0 : 1,
    violations,
    scanned: files.length,
  };
}

function formatViolation(v) {
  return `${v.file}:${v.line}: [${v.kind}] ${v.message}`;
}

/** `--scan-root` replaces the default set; `--exclude` filters what was scanned. */
export function parseArgs(argv) {
  const { values } = parseStandardCliArgs({
    argv,
    extras: {
      'scan-root': { type: 'string-multi', alias: 'scanRoot' },
      exclude: { type: 'string-multi', alias: 'exclude' },
    },
  });
  const scanRoots = values.scanRoot?.length
    ? values.scanRoot
    : [...DEFAULT_SCAN_ROOTS];
  return { scanRoots, exclude: values.exclude ?? [] };
}

async function main() {
  const { scanRoots, exclude } = parseArgs(process.argv.slice(2));
  const result = runCheck({ scanRoots, exclude });
  if (result.violations.length === 0) {
    Logger.info(
      `[check-doc-links] OK — scanned ${result.scanned} active markdown file(s); no violations.`,
    );
    process.exit(0);
    return;
  }
  for (const v of result.violations) {
    process.stderr.write(`${formatViolation(v)}\n`);
  }
  process.stderr.write(
    `\n[check-doc-links] FAILED — ${result.violations.length} violation(s) across ${result.scanned} file(s).\n`,
  );
  process.exit(1);
}

runAsCli(import.meta.url, main, {
  source: 'check-doc-links',
  usage: {
    invocation:
      'node .agents/scripts/check-doc-links.js [--scan-root <path>] [--exclude <glob>]',
    summary:
      'Validate every relative Markdown link and /slash-command token across docs/ and .agents/, reject mentions of retired commands, and reject links that escape the materialized .agents/ payload.',
    flags: [
      [
        '--scan-root <path>',
        'Repeatable. Repo-relative subtree to scan. Replaces the default set (docs, .agents).',
      ],
      [
        '--exclude <glob>',
        'Repeatable. minimatch glob; matching files are dropped from the scan.',
      ],
    ],
    notes: [
      'Consumers materialize only .agents/, so a relative link from .agents/**\nto a framework-repo-only path (tests/, lib/, .claude/, framework docs)\nis reported as a payload-boundary violation even though it resolves here.',
      'Exit codes:\n  0  every link and command token resolves\n  1  at least one violation (file:line on stderr)',
    ],
  },
});
