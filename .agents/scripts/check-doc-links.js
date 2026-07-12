#!/usr/bin/env node

// .agents/scripts/check-doc-links.js
//
// Story #2662 — Internal-link and slash-command resolver for active docs.
//
// Scans every `*.md` under `docs/` and `.agents/` (excluding
// `docs/CHANGELOG.md`) and validates:
//
//   1. Every Markdown relative-path link `[text](relative/path[#anchor])`
//      resolves to a real file on disk (anchors are not validated, only
//      stripped). Absolute URLs (http(s)://, mailto:, etc.) and pure
//      in-document anchors (`#section`) are skipped.
//
//   2. Every `/<slash-command>` token in prose resolves to
//      `.agents/workflows/<command>.md`. A small allowlist tolerates
//      non-slash-command tokens such as `/temp/`, `/dev/`, and common URL
//      path fragments (e.g. `/issues/`, `/blob/`, `/pulls/`).
//
//   3. No active doc mentions any retired slash command. The retired-command
//      blocklist is seeded with `agents-bootstrap-github`,
//      `single-story-plan` (renamed to `/plan`), and `mandrel`
//      (retired in favor of the generated `.agents/docs/workflows.md`
//      catalog) and takes precedence over the workflow-resolution check —
//      a retired token is always a non-zero exit even if a stale workflow
//      file happens to exist.
//
// Exit codes:
//   0  every link and slash-command token resolves cleanly.
//   1  at least one violation; details are written to stderr (file:line).
//
// Helpers (region scanner, token tokenizer, etc.) are intentionally inlined
// per the parent Story's design constraint.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// --- Static config ---------------------------------------------------------

// Retired slash-command tokens that MUST NOT appear in any active doc.
// Tokens are stored WITHOUT the leading slash.
export const RETIRED_COMMANDS = new Set([
  'agents-bootstrap-github',
  'single-story-plan',
  'mandrel',
  // #4482 — dead workflow surface retired (host-native equivalents).
  'explain',
  'git-merge-pr',
]);

// Tokens that look like `/foo` in prose but are not slash commands. Tokens
// are stored WITHOUT the leading slash. The list focuses on common URL path
// fragments and on-disk path roots that appear in tutorial prose. The
// scanner additionally suppresses tokens whose surrounding context makes
// them obviously non-command (see `isCodeFence` and the URL-context heuristic
// in `extractSlashTokens`).
export const SLASH_ALLOWLIST = new Set([
  // workspace/conventional roots
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
  // common GitHub / git URL path fragments
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
  // generic URL path fragments
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
  // common framework / tool URL roots
  'workflows',
  'features',
  'main',
]);

// --- File discovery --------------------------------------------------------

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

export function discoverMarkdown(rootAbs, scanRoots) {
  const out = [];
  for (const sub of scanRoots) {
    const subAbs = path.join(rootAbs, sub);
    if (fs.existsSync(subAbs)) walkMarkdown(subAbs, rootAbs, out);
  }
  out.sort();
  return out;
}

// --- Region masking --------------------------------------------------------

// Returns a copy of `source` where the contents of every fenced code block
// and every inline code span are replaced by spaces. Newlines are preserved
// so that line numbers stay aligned for downstream tokenizers. Fenced blocks
// are matched on `` ``` `` or `~~~` openers at column 0 (with optional
// indentation) and the closing fence MUST match the opener marker.
export function maskCodeRegions(source) {
  const lines = source.split('\n');
  const out = new Array(lines.length);
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
    if (inFence) {
      // Blank the line; keep an empty string so newline survives the join.
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
    // Strip inline code spans (`...`). We do not need to honor escaped
    // backticks for this checker — slash tokens inside inline code are not
    // command references regardless.
    out[i] = line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  }
  return out.join('\n');
}

// --- Link extraction -------------------------------------------------------

// Returns absolute char offset → 1-indexed line number lookup.
function offsetToLine(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

// Match Markdown inline links `[text](target)`. We deliberately keep the
// regex simple: `text` may not contain `]`, and `target` may not contain
// whitespace or `)`. Reference-style links are out of scope for this
// checker (the repo uses inline links exclusively).
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

// --- Slash-token extraction ------------------------------------------------

// Tokens look like `/<lowercase-alphanum-with-hyphens>`. We exclude tokens
// preceded by a word character or another slash (URL paths, `http://...`),
// and tokens immediately followed by a word/`-` character (so we match the
// whole command, not a prefix).
// A slash token is `/<name>` where:
//   - the preceding char is NOT a word char, `/`, `:`, `.`, `>`, `]`, `)`,
//     so we don't match URL path segments or fragments embedded in paths
//     like `temp/epic-<id>/lifecycle.ndjson` (preceded by `>`) or
//     `temp/epic-[ID]/tickets.json` (preceded by `]`).
//   - the following char is NOT a word char, `-`, or `.`, so file
//     extensions like `/tickets.json` and identifier suffixes don't match.
// The optional `(?::[a-z][a-z0-9-]*)?` tail captures the namespaced
// `/loops:<name>` command form (Story #4289). Without it the matcher would
// stop at `loops` and try to resolve `.agents/workflows/loops.md`, which does
// not exist — loop units live under `loops/<name>.md`. The resolver below
// splits the captured `loops:<name>` token on the `:` to resolve the
// namespaced path.
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

// --- Per-file check --------------------------------------------------------

export function checkFile(absPath, repoRoot) {
  const violations = [];
  const source = fs.readFileSync(absPath, 'utf8');
  const masked = maskCodeRegions(source);
  const fileDir = path.dirname(absPath);
  const relFile = path.relative(repoRoot, absPath).split(path.sep).join('/');
  const workflowsDir = path.join(repoRoot, '.agents', 'workflows');

  // Tokenize the masked source once and reuse the array across both the
  // retired-command sweep and the slash-command resolution pass below.
  const slashTokens = extractSlashTokens(masked);

  // 1. Retired-command sweep — runs against the masked source so command
  //    references inside fenced examples don't trip us, but we still catch
  //    every prose mention. Retired-command checks ALWAYS take precedence:
  //    even if the token would otherwise be allowlisted or resolved, a hit
  //    here is a non-zero exit.
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

  // 2. Relative-link resolution.
  for (const { target, line } of extractLinks(masked)) {
    if (isExternalOrInternalAnchor(target)) continue;
    const pathOnly = stripAnchorAndQuery(target);
    if (!pathOnly) continue; // pure anchor that survived earlier check
    let resolved;
    if (pathOnly.startsWith('/')) {
      // Treat root-absolute paths as repo-root relative.
      resolved = path.join(repoRoot, pathOnly);
    } else {
      resolved = path.resolve(fileDir, pathOnly);
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

  // 3. Slash-command resolution. Skip retired hits (already reported) and
  //    allowlisted tokens. A command is valid if it resolves to a top-level
  //    workflow file OR to a helpers/ module (helpers are not projected into
  //    the `.claude/commands/` tree but are still legitimate named workflows
  //    that parent workflows invoke by prose reference).
  for (const { token, line } of slashTokens) {
    if (RETIRED_COMMANDS.has(token)) continue;
    if (SLASH_ALLOWLIST.has(token)) continue;
    // Namespaced loop commands (`/loops:<name>`, Story #4289) resolve to a
    // loop unit under `.agents/workflows/loops/<name>.md`. Split on the `:`
    // and resolve the namespaced path rather than a flat `loops:<name>.md`.
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

// --- Public entry point ----------------------------------------------------

/**
 * Run the checker programmatically. Returns `{ exitCode, violations }`.
 * `exitCode` is 0 when every doc is clean, 1 otherwise.
 *
 * @param {object} [options]
 * @param {string} [options.repoRoot] Defaults to the framework repo root.
 * @param {string[]} [options.scanRoots] Defaults to `['docs', '.agents']`.
 */
export function runCheck(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const scanRoots = options.scanRoots ?? ['docs', '.agents'];
  const files = discoverMarkdown(repoRoot, scanRoots);
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

async function main() {
  const result = runCheck();
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

runAsCli(import.meta.url, main, { source: 'check-doc-links' });
