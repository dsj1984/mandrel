#!/usr/bin/env node

/**
 * CLI: the comment policy ratchets (docs/contributing/comment-policy.md).
 *
 * Default mode runs both ratchets: the comment-byte ratio over non-generated,
 * non-test `.agents/scripts` JavaScript may not exceed the landed ceiling, and
 * no comment under `.agents/scripts`, `bin` or `lib` may cite a ticket, pull
 * request or decision-record number.
 *
 * `--assert-code-unchanged <ref>` is the safety net for a comment-only change:
 * every scanned file that differs from `<ref>` must have the same
 * comment-stripped, whitespace-normalized code and the same JSDoc type tags.
 * Contributor-only, so it lives in `scripts/` and never ships.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import {
  COMMENT_RATIO_CEILING,
  commentBytes,
  findProvenance,
  isScannedSource,
  normalizedCode,
  PROVENANCE_ROOTS,
  RATIO_ROOT,
  typeTags,
} from './lib/comment-policy.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const HELP = {
  invocation:
    'node scripts/check-comment-policy.js [--root <dir>] [--assert-code-unchanged <ref>] [--only <prefix>]... [--report]',
  summary:
    'Hold the comment policy: a comment-byte ratio ceiling and a ban on ticket/PR/ADR citations in comments; or prove a change touched comments only.',
  flags: [
    {
      flag: '--root <dir>',
      description: 'Repository root (default: this checkout).',
    },
    {
      flag: '--assert-code-unchanged <ref>',
      description:
        'Fail when any scanned file differs from <ref> in anything but comments and whitespace, or lost a JSDoc type tag.',
    },
    {
      flag: '--only <prefix>',
      description:
        'Restrict the assertion or the report to paths under <prefix> (repeatable).',
    },
    {
      flag: '--report',
      description:
        'Print per-file comment ratios, largest comment bytes first.',
    },
  ],
  notes: [
    'Exit codes:\n  0  policy holds\n  1  a ratchet or the assertion failed; offenders are printed',
  ],
};

/**
 * Parse argv into options.
 *
 * @param {string[]} argv
 * @returns {{ root: string, ref: string | null, only: string[], report: boolean }}
 */
function parseOptions(argv) {
  const opts = { root: REPO_ROOT, ref: null, only: [], report: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.root = path.resolve(argv[++i]);
    else if (arg === '--assert-code-unchanged') opts.ref = argv[++i];
    else if (arg === '--only') opts.only.push(argv[++i].replace(/\/$/, ''));
    else if (arg === '--report') opts.report = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * Run git in `root` and return stdout.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Tracked and untracked-but-not-ignored scanned files under `roots`.
 *
 * @param {string} root
 * @param {string[]} roots
 * @returns {string[]}
 */
function listSources(root, roots) {
  return git(root, ['ls-files', '-co', '--exclude-standard', '--', ...roots])
    .split('\n')
    .filter((f) => f && isScannedSource(f));
}

/**
 * True when `file` is under one of `prefixes` (or no prefix is given).
 *
 * @param {string} file
 * @param {string[]} prefixes
 * @returns {boolean}
 */
function inScope(file, prefixes) {
  return (
    prefixes.length === 0 ||
    prefixes.some((p) => file === p || file.startsWith(`${p}/`))
  );
}

/**
 * The ratio ratchet.
 *
 * @param {string} root
 * @param {{ only: string[], report: boolean }} opts
 * @returns {boolean}
 */
function checkRatio(root, opts) {
  let total = 0;
  let comment = 0;
  const rows = [];
  for (const file of listSources(root, [RATIO_ROOT])) {
    const counts = commentBytes(readFileSync(path.join(root, file), 'utf8'));
    total += counts.total;
    comment += counts.comment;
    if (inScope(file, opts.only)) rows.push({ file, ...counts });
  }
  if (opts.report) {
    rows.sort((a, b) => b.comment - a.comment);
    for (const r of rows) {
      const pct = ((100 * r.comment) / (r.total || 1)).toFixed(1);
      process.stdout.write(
        `${String(r.comment).padStart(8)}  ${pct.padStart(5)}%  ${r.file}\n`,
      );
    }
  }
  const ratio = comment / (total || 1);
  const line = `comment bytes ${comment} of ${total} (${(100 * ratio).toFixed(1)}%), ceiling ${(100 * COMMENT_RATIO_CEILING).toFixed(1)}%`;
  if (ratio <= COMMENT_RATIO_CEILING) {
    process.stdout.write(`[comment-policy] ratio: ${line} — ok\n`);
    return true;
  }
  process.stderr.write(
    `[comment-policy] ratio: ${line} — over the ceiling. Trim comments to the policy in docs/contributing/comment-policy.md.\n`,
  );
  return false;
}

/**
 * The provenance lint.
 *
 * @param {string} root
 * @returns {boolean}
 */
function checkProvenance(root) {
  const offenders = [];
  for (const file of listSources(root, PROVENANCE_ROOTS)) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const hit of findProvenance(source)) {
      offenders.push(`${file}:${hit.line}  ${hit.match}`);
    }
  }
  if (offenders.length === 0) {
    process.stdout.write(
      '[comment-policy] provenance: no ticket, PR or ADR citation in a comment — ok\n',
    );
    return true;
  }
  process.stderr.write(
    `[comment-policy] provenance: ${offenders.length} comment citation(s). A comment states the reason, not the ticket that found it — history lives in git and docs/decisions.md.\n`,
  );
  for (const o of offenders) process.stderr.write(`  ${o}\n`);
  return false;
}

/**
 * Differences between two multisets of sorted keys, as `-key` / `+key`.
 *
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string[]}
 */
function lostKeys(before, after) {
  const remaining = new Map();
  for (const k of after) remaining.set(k, (remaining.get(k) ?? 0) + 1);
  const lost = [];
  for (const k of before) {
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else lost.push(k);
  }
  return lost;
}

/**
 * The comment-only assertion against `ref`.
 *
 * @param {string} root
 * @param {{ ref: string, only: string[] }} opts
 * @returns {boolean}
 */
function assertCodeUnchanged(root, opts) {
  const changed = new Set(
    git(root, ['diff', '--name-only', opts.ref, '--', ...PROVENANCE_ROOTS])
      .split('\n')
      .filter(Boolean),
  );
  for (const f of git(root, [
    'ls-files',
    '-o',
    '--exclude-standard',
    '--',
    ...PROVENANCE_ROOTS,
  ]).split('\n')) {
    if (f) changed.add(f);
  }
  const files = [...changed]
    .filter((f) => isScannedSource(f) && inScope(f, opts.only))
    .sort();
  const failures = [];
  for (const file of files) {
    let before;
    try {
      before = git(root, ['show', `${opts.ref}:${file}`]);
    } catch {
      failures.push(`${file}: added (a comment-only change adds no file)`);
      continue;
    }
    let after;
    try {
      after = readFileSync(path.join(root, file), 'utf8');
    } catch {
      failures.push(`${file}: deleted`);
      continue;
    }
    const a = normalizedCode(before);
    const b = normalizedCode(after);
    if (a !== b) {
      failures.push(
        `${file}: code changed outside comments\n${firstDifference(a, b)}`,
      );
    }
    const lost = lostKeys(typeTags(before), typeTags(after));
    if (lost.length > 0)
      failures.push(`${file}: lost JSDoc tag(s) ${lost.join(', ')}`);
  }
  if (failures.length === 0) {
    process.stdout.write(
      `[comment-policy] code-unchanged vs ${opts.ref}: ${files.length} changed file(s), comments and whitespace only, JSDoc type tags intact — ok\n`,
    );
    return true;
  }
  process.stderr.write(
    `[comment-policy] code-unchanged vs ${opts.ref}: ${failures.length} failure(s)\n`,
  );
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  return false;
}

/**
 * Where two normalized sources first differ, as a pair of short excerpts.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  const around = (t) => t.slice(Math.max(0, i - 80), i + 80);
  return `    base: …${around(a)}…\n    now:  …${around(b)}…`;
}

runAsCli(
  import.meta.url,
  async () => {
    const opts = parseOptions(process.argv.slice(2));
    const ok = opts.ref
      ? assertCodeUnchanged(opts.root, opts)
      : [checkRatio(opts.root, opts), checkProvenance(opts.root)].every(
          Boolean,
        );
    if (!ok) process.exitCode = 1;
  },
  { source: 'comment-policy', usage: HELP },
);
