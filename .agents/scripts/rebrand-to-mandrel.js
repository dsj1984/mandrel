#!/usr/bin/env node
/**
 * CLI: rebrand `agent-protocols` → `mandrel` across the working tree
 * (Epic #1184, Story #1604).
 *
 * Behaviour:
 *   - Enumerates files via `git ls-files` (tracked only; untracked +
 *     `node_modules/` ignored by construction).
 *   - Skips any path covered by `.agents/scripts/lib/rebrand-deny.js`.
 *   - Performs case-preserving replacement:
 *       `Agent Protocols`  → `Mandrel`
 *       `agent-protocols`  → `mandrel`
 *       `AGENT_PROTOCOLS`  → `MANDREL`
 *   - Idempotent: re-running on an already-rebranded tree produces an
 *     empty diff (the source patterns no longer match).
 *   - Reports a JSON envelope to stdout describing files scanned, files
 *     changed, replacement counts per token, and the deny-list hit count.
 *
 * Flags:
 *   --dry-run        — Compute the changes but do not write to disk.
 *   --root <path>    — Repo root (defaults to `process.cwd()`).
 *   --json           — Emit only the JSON envelope (default true; kept for
 *                      forward-compatibility with a human-readable mode).
 *
 * Exit codes:
 *   0  — Success (changes applied or dry-run summary printed).
 *   1  — Unrecoverable error (failed to enumerate git ls-files, fs write
 *        error, etc.).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { runAsCli } from './lib/cli-utils.js';
import { isDenied } from './lib/rebrand-deny.js';

/**
 * Ordered replacement table. Order matters: the space-separated form
 * (`Agent Protocols`) must run before the hyphenated form so that a hit
 * on `Agent Protocols` does not leave a stray `Protocols` token behind.
 *
 * @type {Array<{ from: RegExp, to: string, label: string }>}
 */
export const REPLACEMENTS = Object.freeze([
  { from: /Agent Protocols/g, to: 'Mandrel', label: 'Agent Protocols' },
  { from: /AGENT_PROTOCOLS/g, to: 'MANDREL', label: 'AGENT_PROTOCOLS' },
  { from: /agent-protocols/g, to: 'mandrel', label: 'agent-protocols' },
]);

/**
 * Apply the case-preserving rebrand to a single string. Pure — no I/O.
 *
 * Returns `{ next, counts }` where `counts` is a per-label tally of how
 * many replacements fired (0 when the string is already rebranded).
 *
 * @param {string} content
 * @returns {{ next: string, counts: Record<string, number> }}
 */
export function rebrandString(content) {
  const counts = Object.create(null);
  let next = content;
  for (const { from, to, label } of REPLACEMENTS) {
    let n = 0;
    next = next.replace(from, () => {
      n += 1;
      return to;
    });
    if (n > 0) counts[label] = n;
  }
  return { next, counts };
}

/**
 * Enumerate tracked files via `git ls-files`. Returns POSIX-normalised
 * repo-relative paths.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function listTrackedFiles(cwd) {
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\0')
    .filter((s) => s.length > 0)
    .map((p) => p.replace(/\\/g, '/'));
}

/**
 * Decide whether a file is a candidate for in-place rewrite. Skips
 * deny-listed paths and binary files (detected by NUL byte presence in
 * the first 8 KB).
 *
 * @param {string} relPath
 * @param {string} absPath
 * @returns {{ skip: boolean, reason?: string }}
 */
export function classify(relPath, absPath) {
  if (isDenied(relPath)) return { skip: true, reason: 'denied' };
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    for (let i = 0; i < n; i += 1) {
      if (buf[i] === 0) return { skip: true, reason: 'binary' };
    }
  } catch (err) {
    return { skip: true, reason: `unreadable:${err.code || 'unknown'}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { skip: false };
}

/**
 * Main entry point. Returns a JSON-serialisable envelope.
 *
 * @param {{ root: string, dryRun: boolean }} opts
 * @returns {{
 *   ok: boolean,
 *   dryRun: boolean,
 *   scanned: number,
 *   denied: number,
 *   skippedBinary: number,
 *   changed: number,
 *   replacements: Record<string, number>,
 *   files: Array<{ path: string, counts: Record<string, number> }>,
 * }}
 */
export function run(opts) {
  const { root, dryRun } = opts;
  const files = listTrackedFiles(root);
  const totalCounts = Object.create(null);
  const changedFiles = [];
  let denied = 0;
  let skippedBinary = 0;

  for (const rel of files) {
    const abs = path.join(root, rel);
    const cls = classify(rel, abs);
    if (cls.skip) {
      if (cls.reason === 'denied') denied += 1;
      else if (cls.reason === 'binary') skippedBinary += 1;
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const { next, counts } = rebrandString(content);
    if (next === content) continue;
    for (const [label, n] of Object.entries(counts)) {
      totalCounts[label] = (totalCounts[label] || 0) + n;
    }
    changedFiles.push({ path: rel, counts });
    if (!dryRun) fs.writeFileSync(abs, next, 'utf8');
  }

  return {
    ok: true,
    dryRun,
    scanned: files.length,
    denied,
    skippedBinary,
    changed: changedFiles.length,
    replacements: totalCounts,
    files: changedFiles,
  };
}

/**
 * Parse process.argv-style array. Recognised flags listed at top of file.
 *
 * @param {string[]} argv
 * @returns {{ root: string, dryRun: boolean }}
 */
export function parseArgs(argv) {
  let root = process.cwd();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--root') {
      root = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--root=')) {
      root = a.slice('--root='.length);
    }
  }
  return { root, dryRun };
}

runAsCli(
  import.meta.url,
  async () => {
    const opts = parseArgs(process.argv.slice(2));
    const result = run(opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  },
  { source: 'rebrand-to-mandrel' },
);
