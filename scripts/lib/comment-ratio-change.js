/**
 * comment-ratio-change.js — what one change contributes to the comment ratio.
 *
 * The ratio ratchet judges a change by its own net diff against a base commit
 * rather than by the global figure alone, so a sibling's landing cannot fail a
 * change that is within the ceiling. This module resolves that base and sums
 * the diff's comment and total bytes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  COMMENT_RATIO_CEILING,
  commentBytes,
  isScannedSource,
  RATIO_ROOT,
} from './comment-policy.js';

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
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Run git in `root`, returning stdout or `null` on a non-zero exit.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {string | null}
 */
function tryGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/**
 * `project.baseBranch` from the local override, then `.agentrc.json`. Read
 * directly rather than through the config resolver, which loads `.env` and
 * rewrites the GitHub CLI environment as side effects.
 *
 * @param {string} root
 * @returns {string}
 */
function baseBranchOf(root) {
  for (const name of ['.agentrc.local.json', '.agentrc.json']) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    try {
      const branch = JSON.parse(readFileSync(file, 'utf8'))?.project
        ?.baseBranch;
      if (typeof branch === 'string' && branch) return branch;
    } catch {}
  }
  return 'main';
}

/**
 * The commit a change is judged against: `--base` as given, else the merge
 * base of HEAD and the remote-tracking base branch, so a stale local branch
 * cannot widen the change. `null` when nothing resolves.
 *
 * @param {string} root
 * @param {string | null} override
 * @returns {string | null}
 */
export function resolveBase(root, override) {
  if (override)
    return (
      tryGit(root, ['rev-parse', '--verify', `${override}^{commit}`])?.trim() ??
      null
    );
  const branch = baseBranchOf(root);
  for (const candidate of [`origin/${branch}`, branch]) {
    const base = tryGit(root, ['merge-base', candidate, 'HEAD'])?.trim();
    if (base) return base;
  }
  return null;
}

/**
 * Comment and total bytes of `source`, or zeros when it is absent.
 *
 * @param {string | null} source
 * @returns {{ comment: number, total: number }}
 */
function countsOf(source) {
  return source === null ? { comment: 0, total: 0 } : commentBytes(source);
}

/**
 * Net comment and total bytes the working tree adds to the ratio surface
 * over `base`: tracked edits (uncommitted included) and untracked files.
 *
 * @param {string} root
 * @param {string} base
 * @returns {{ comment: number, total: number }}
 */
export function changeDelta(root, base) {
  const changed = git(root, [
    'diff',
    '--name-only',
    '--no-renames',
    base,
    '--',
    RATIO_ROOT,
  ]);
  const untracked = git(root, [
    'ls-files',
    '-o',
    '--exclude-standard',
    '--',
    RATIO_ROOT,
  ]);
  const files = new Set(
    `${changed}\n${untracked}`
      .split('\n')
      .filter((f) => f && isScannedSource(f)),
  );
  const delta = { comment: 0, total: 0 };
  for (const file of files) {
    const abs = path.join(root, file);
    const after = countsOf(existsSync(abs) ? readFileSync(abs, 'utf8') : null);
    const before = countsOf(tryGit(root, ['show', `${base}:${file}`]));
    delta.comment += after.comment - before.comment;
    delta.total += after.total - before.total;
  }
  return delta;
}

const pct = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

const POLICY = 'docs/contributing/comment-policy.md';

/**
 * The ratio verdict. A change fails only when the global ratio is over the
 * ceiling and its own net diff adds comment bytes at a share above the
 * ceiling. A change at or under the ceiling therefore cannot fail, whatever
 * landed beside it, and while the global ratio is over, every change that
 * passes pulls it back down. With no base (`delta` null) the absolute ceiling
 * applies.
 *
 * @param {{ comment: number, total: number }} counts global bytes
 * @param {string | null} base the commit the change is judged against
 * @param {{ comment: number, total: number } | null} delta the change's net bytes
 * @returns {{ ok: boolean, out: string[], err: string[] }} lines for stdout and stderr
 */
export function ratioVerdict(counts, base, delta) {
  const over = counts.comment / (counts.total || 1) > COMMENT_RATIO_CEILING;
  const global = `comment bytes ${counts.comment} of ${counts.total} (${pct(counts.comment, counts.total)}), ceiling ${pct(COMMENT_RATIO_CEILING, 1)}`;
  if (delta === null) {
    const fallback = 'no base ref resolved — applying the absolute ceiling.';
    return over
      ? {
          ok: false,
          out: [],
          err: [
            fallback,
            `${global} — over the ceiling. Trim comments to the policy in ${POLICY}.`,
          ],
        }
      : { ok: true, out: [`${global} — ok`], err: [fallback] };
  }
  const share = delta.total > 0 ? pct(delta.comment, delta.total) : 'n/a';
  const line = `${global}; this change vs ${base.slice(0, 9)}: comment ${delta.comment} of ${delta.total} bytes (${share})`;
  const excess = delta.comment - COMMENT_RATIO_CEILING * delta.total;
  if (!over) return { ok: true, out: [`${line} — ok`], err: [] };
  if (delta.comment <= 0 || excess <= 0) {
    const warn =
      'warn — the global ratio is over the ceiling, but this change is within it, so it is not blocked.';
    return { ok: true, out: [`${line} — ok`], err: [warn] };
  }
  return {
    ok: false,
    out: [],
    err: [
      `${line} — the global ratio is over the ceiling and this change is above it. Trim at least ${Math.ceil(excess)} comment bytes from this change's own diff, per ${POLICY}.`,
    ],
  };
}
