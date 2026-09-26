#!/usr/bin/env node

/**
 * clean-worktrees.js — enumerate every git worktree of this project (plus
 * unregistered directories under `.worktrees/`), classify each as a removal
 * candidate or as kept-with-a-reason, and — only under `--execute` — remove
 * the candidates through the worktree removal seam (flags: see HELP).
 *
 * Candidate classes: `closed-story`, `merged-branch`, `orphan-dir`,
 * `detached`. Safety: dry-run by default; nothing outside the project root,
 * no dirty tree, no HEAD unreachable from a remote-tracking ref, no tree a
 * live process uses, and a `detached` tree only on a per-entry interactive
 * yes (never under `--yes`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { spawnCapture } from './lib/child-exec.js';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import * as defaultGit from './lib/git-utils.js';
import { AGENT_LABELS } from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';
import { makeGhRunner } from './lib/single-story-sweep/protection-ctx.js';
import { canonicalPath } from './lib/worktree/canonical-path.js';
import {
  isInsideWorktree,
  parseWorktreePorcelain,
  samePath,
} from './lib/worktree/inspector.js';
import {
  findRunningCodeInside,
  removeWorktreeWithRecovery,
} from './lib/worktree/lifecycle/reap.js';

export const CLASSES = Object.freeze({
  CLOSED_STORY: 'closed-story',
  MERGED_BRANCH: 'merged-branch',
  ORPHAN_DIR: 'orphan-dir',
  DETACHED: 'detached',
});

const WORKTREE_DIR = '.worktrees';

/** Removal-seam diagnostics go to stderr: stdout carries the table / JSON. */
const STDERR_LOGGER = Object.freeze({
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
  error: (m) => process.stderr.write(`${m}\n`),
});

const writeStdout = (text) => process.stdout.write(`${text}\n`);

const HELP = `Usage: node .agents/scripts/clean-worktrees.js [options]

Lists every worktree of this project — each registered one plus any
unregistered directory under .worktrees/ — as a removal candidate or as
kept with a reason, and prints its size. Dry-run by default: nothing is
removed without --execute.

Candidate classes:
  closed-story    .worktrees/story-<id> whose Story is closed or agent::done
  merged-branch   a branch whose PR is MERGED and whose HEAD is the merged head
  orphan-dir      a directory under .worktrees/ git does not register
  detached        a registered worktree with a detached HEAD
                  (e.g. .claude/worktrees/*) — removed only on a per-entry
                  interactive yes, never under --yes

Always kept: the main checkout, anything outside the project root, a dirty
tree, a HEAD no remote-tracking ref contains, a tree the running process or
(macOS/Linux) any live process uses, an open Story, an unmerged branch.

Options:
  --execute   Remove candidates (asks per entry unless --yes).
  --yes       With --execute, remove non-detached candidates without asking.
  --json      Emit the result envelope (with bytesReclaimed) as JSON.
  --cwd <dir> Checkout to inspect. Default: this project's root.
  -h, --help  Show this help.
`;

/** Containment on canonical paths (8.3 short names, symlinks, case). */
function isWithin(child, parent, platform) {
  return isInsideWorktree(
    canonicalPath(child),
    canonicalPath(parent),
    platform,
  );
}

/**
 * Working directories of every visible process, or `null` where the platform
 * does not expose them (Windows) — callers then skip the live-process check.
 *
 * @param {{ platform?: string, fsImpl?: typeof fs, spawn?: Function }} [deps]
 * @returns {string[]|null}
 */
export function listProcessCwds({
  platform = process.platform,
  fsImpl = fs,
  spawn = spawnCapture,
} = {}) {
  if (platform === 'linux') return linuxProcessCwds(fsImpl);
  if (platform === 'darwin') return darwinProcessCwds(spawn);
  return null;
}

function linuxProcessCwds(fsImpl) {
  let pids;
  try {
    pids = fsImpl.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  const cwds = [];
  for (const pid of pids) {
    try {
      cwds.push(fsImpl.readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      // Another user's process, or it exited — not ours to see.
    }
  }
  return cwds;
}

function darwinProcessCwds(spawn) {
  const res = spawn('lsof', ['-w', '-a', '-d', 'cwd', '-Fn']);
  if (!res || typeof res.stdout !== 'string' || res.stdout === '') return null;
  return res.stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

/**
 * Directory size in bytes; `du` where available, else a recursive walk that
 * never follows symlinks. `null` when unreadable.
 *
 * @param {string} dir
 * @param {{ platform?: string, spawn?: Function, fsImpl?: typeof fs }} [deps]
 * @returns {number|null}
 */
export function dirSizeBytes(
  dir,
  { platform = process.platform, spawn = spawnCapture, fsImpl = fs } = {},
) {
  if (platform !== 'win32') {
    const res = spawn('du', ['-sk', dir]);
    const kb = Number.parseInt(String(res?.stdout ?? ''), 10);
    if (res?.status === 0 && Number.isFinite(kb)) return kb * 1024;
  }
  return walkSize(dir, fsImpl);
}

function walkSize(target, fsImpl) {
  let stat;
  try {
    stat = fsImpl.lstatSync(target);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of fsImpl.readdirSync(target)) {
    total += walkSize(path.join(target, name), fsImpl) ?? 0;
  }
  return total;
}

/**
 * Registered worktrees (main first, as git lists it) plus directories under
 * `<projectRoot>/.worktrees/` that git does not register.
 *
 * @param {{ cwd: string, git: object, platform: string, fsImpl?: typeof fs }} args
 * @returns {{ projectRoot: string, registered: object[], orphans: string[] }}
 */
export function enumerateWorktrees({ cwd, git, platform, fsImpl = fs }) {
  const res = git.gitSpawn(cwd, 'worktree', 'list', '--porcelain');
  if (res.status !== 0) {
    throw new Error(
      `git worktree list failed: ${res.stderr || res.stdout || 'unknown'}`,
    );
  }
  const registered = parseWorktreePorcelain(res.stdout || '');
  if (registered.length === 0) throw new Error('git listed no worktrees');
  const projectRoot = canonicalPath(registered[0].path);
  const known = registered.map((r) => canonicalPath(r.path));
  const wtDir = path.join(projectRoot, WORKTREE_DIR);
  let names = [];
  try {
    names = fsImpl
      .readdirSync(wtDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // No .worktrees/ directory: nothing orphaned.
  }
  const orphans = names
    .map((name) => path.join(wtDir, name))
    .filter((p) => !known.some((k) => samePath(k, canonicalPath(p), platform)));
  return { projectRoot, registered, orphans };
}

/** Kept-reason for a tree the running process or a live process uses. */
function liveUseReason(wtPath, env) {
  if (findRunningCodeInside(env, wtPath, env.guardPaths)) {
    return 'running-from-tree';
  }
  const cwds = env.processCwds ?? [];
  if (cwds.some((c) => isWithin(c, wtPath, env.platform))) {
    return 'live-process';
  }
  return null;
}

/** Kept-reason when the tree holds work that exists nowhere else. */
function uniqueWorkReason(rec, env) {
  const status = env.git.gitSpawn(rec.path, 'status', '--porcelain');
  if (status.status !== 0 || status.stdout.trim() !== '') return 'dirty-tree';
  if (!rec.head) return 'unpushed-commits';
  const refs = env.git.gitSpawn(
    env.projectRoot,
    'for-each-ref',
    '--contains',
    rec.head,
    '--count=1',
    '--format=%(refname)',
    'refs/remotes/',
  );
  if (refs.status !== 0 || refs.stdout.trim() === '') {
    return 'unpushed-commits';
  }
  return null;
}

function isStoryDone(ticket) {
  if (!ticket) return false;
  if (ticket.state === 'closed') return true;
  return (ticket.labels ?? []).includes(AGENT_LABELS.DONE);
}

async function classifyStory(storyId, env) {
  try {
    const ticket = await env.getTicket(storyId);
    return isStoryDone(ticket)
      ? { class: CLASSES.CLOSED_STORY }
      : { reason: 'story-open' };
  } catch (err) {
    return { reason: `provider-error: ${err?.message ?? err}` };
  }
}

function classifyBranch(rec, env) {
  let prs;
  try {
    prs = env.prLookup(rec.branch);
  } catch (err) {
    return { reason: `pr-lookup-failed: ${err?.message ?? err}` };
  }
  const merged = (prs ?? []).some((pr) => pr?.headRefOid === rec.head);
  return merged
    ? { class: CLASSES.MERGED_BRANCH }
    : { reason: 'unmerged-branch' };
}

/** A Story id only for `<projectRoot>/.worktrees/story-<id>` on `story-<id>`. */
function storyIdOf(rec, env) {
  const parent = path.dirname(path.resolve(rec.path));
  const wtDir = path.join(env.projectRoot, WORKTREE_DIR);
  if (!samePath(canonicalPath(parent), canonicalPath(wtDir), env.platform)) {
    return null;
  }
  const fromDir = defaultGit.parseStoryBranch(path.basename(rec.path));
  return fromDir !== null && fromDir === defaultGit.parseStoryBranch(rec.branch)
    ? fromDir
    : null;
}

/** First kept-reason that needs no network, or `null`. */
function localKeepReason(rec, env) {
  if (rec.bare) return 'bare';
  if (!isWithin(rec.path, env.projectRoot, env.platform)) {
    return 'outside-project';
  }
  if (!fs.existsSync(rec.path)) return 'path-missing';
  return liveUseReason(rec.path, env) ?? uniqueWorkReason(rec, env);
}

/**
 * @param {object} rec a `parseWorktreePorcelain` record
 * @param {object} env
 * @returns {Promise<{ class?: string, reason?: string }>}
 */
async function classifyRegistered(rec, env) {
  const kept = localKeepReason(rec, env);
  if (kept) return { reason: kept };
  if (rec.detached) return { class: CLASSES.DETACHED };
  const storyId = storyIdOf(rec, env);
  if (storyId !== null) return classifyStory(storyId, env);
  return classifyBranch(rec, env);
}

/**
 * Classify every worktree: exactly one of `class` (a candidate) or `reason`
 * (kept) per entry.
 *
 * @param {object} env resolved dependencies (see `buildEnv`)
 * @returns {Promise<object[]>}
 */
export async function classifyWorktrees(env) {
  const entries = [];
  const [main, ...rest] = env.registered;
  entries.push(entryOf(main, { reason: 'main-checkout' }, false));
  for (const rec of rest) {
    entries.push(entryOf(rec, await classifyRegistered(rec, env), true, env));
  }
  for (const dir of env.orphans) {
    const reason = liveUseReason(dir, env);
    const verdict = reason ? { reason } : { class: CLASSES.ORPHAN_DIR };
    entries.push(entryOf({ path: dir }, verdict, true, env));
  }
  return entries;
}

function entryOf(rec, verdict, sized, env) {
  const exists = sized && fs.existsSync(rec.path);
  return {
    // One spelling per tree: git's `C:/…` and a short-name `RUNNER~1` form
    // both become the canonical native path.
    path: canonicalPath(rec.path),
    branch: rec.branch ?? null,
    head: rec.head ?? null,
    class: verdict.class ?? null,
    reason: verdict.reason ?? null,
    sizeBytes: exists ? env.sizeOf(rec.path) : null,
    action: verdict.class ? 'candidate' : 'kept',
  };
}

/**
 * Whether to remove one candidate: `--yes` covers every class but
 * `detached`, which only a per-entry interactive yes can remove.
 *
 * @returns {Promise<{ remove: boolean, reason?: string }>}
 */
async function decide(entry, opts) {
  const detached = entry.class === CLASSES.DETACHED;
  if (opts.yes && !detached) return { remove: true };
  if (detached && opts.yes) {
    return { remove: false, reason: 'detached-never-under-yes' };
  }
  if (!opts.confirm) {
    return { remove: false, reason: 'needs-confirmation' };
  }
  const ok = await opts.confirm(entry);
  return ok ? { remove: true } : { remove: false, reason: 'declined' };
}

/**
 * Remove the candidates `decide` approves; returns bytes reclaimed.
 *
 * @param {object[]} entries mutated in place (`action`, `reason`)
 * @param {object} opts `{ yes, confirm, removeFn }`
 * @returns {Promise<number>}
 */
export async function executeRemovals(entries, opts) {
  let bytes = 0;
  for (const entry of entries.filter((e) => e.class)) {
    const verdict = await decide(entry, opts);
    if (!verdict.remove) {
      entry.action = 'skipped';
      entry.reason = verdict.reason;
      continue;
    }
    const res = await opts.removeFn(entry.path);
    entry.action = res.removed ? 'removed' : 'failed';
    if (!res.removed) {
      entry.reason = `remove-failed: ${res.reason ?? 'unknown'}`;
      continue;
    }
    bytes += entry.sizeBytes ?? 0;
  }
  return bytes;
}

function makeRemoveFn({ projectRoot, git, platform, logger }) {
  const ctx = {
    repoRoot: projectRoot,
    git,
    platform,
    logger,
    worktreeRoot: path.join(projectRoot, WORKTREE_DIR),
    listCache: { list: null, ts: 0 },
  };
  return (wtPath) => removeWorktreeWithRecovery(ctx, wtPath, {});
}

function makeTicketReader(projectRoot) {
  let provider = null;
  return (id) => {
    provider ??= createProvider(resolveConfig({ cwd: projectRoot }));
    return provider.getTicket(id);
  };
}

function makePrLookup(projectRoot) {
  const gh = makeGhRunner(projectRoot);
  return (branch) =>
    JSON.parse(
      gh([
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'merged',
        '--json',
        'number,headRefOid',
        '--limit',
        '10',
      ]) || '[]',
    );
}

/**
 * Resolve every dependency, defaulting to the real ones.
 *
 * @param {object} args
 * @returns {object}
 */
function buildEnv(args) {
  const platform = args.platform ?? process.platform;
  const git = args.git ?? defaultGit;
  const cwd = path.resolve(args.cwd ?? PROJECT_ROOT);
  const listing = enumerateWorktrees({ cwd, git, platform });
  const { projectRoot } = listing;
  return {
    ...listing,
    platform,
    git,
    guardPaths: [cwd, process.cwd(), ...(args.runningPaths ?? [])],
    processCwds:
      args.processCwds !== undefined
        ? args.processCwds
        : listProcessCwds({ platform }),
    getTicket: args.getTicket ?? makeTicketReader(projectRoot),
    prLookup: args.prLookup ?? makePrLookup(projectRoot),
    sizeOf: args.sizeOf ?? ((p) => dirSizeBytes(p, { platform })),
    removeFn:
      args.removeFn ??
      makeRemoveFn({
        projectRoot,
        git,
        platform,
        logger: args.logger ?? STDERR_LOGGER,
      }),
  };
}

/**
 * Enumerate, classify and (under `execute`) remove. Seams for tests: every
 * `buildEnv` dependency may be injected.
 *
 * @param {object} [args]
 * @param {string} [args.cwd]
 * @param {boolean} [args.execute]
 * @param {boolean} [args.yes]
 * @param {Function|null} [args.confirm] per-entry interactive prompt
 * @returns {Promise<object>} the `clean-worktrees` envelope.
 */
export async function runCleanWorktrees(args = {}) {
  const env = buildEnv(args);
  const entries = await classifyWorktrees(env);
  const bytesReclaimed = args.execute
    ? await executeRemovals(entries, {
        yes: args.yes === true,
        confirm: args.confirm ?? null,
        removeFn: env.removeFn,
      })
    : 0;
  return {
    kind: 'clean-worktrees',
    mode: args.execute ? 'execute' : 'dry-run',
    projectRoot: env.projectRoot,
    entries,
    bytesReclaimed,
  };
}

/**
 * @param {number|null} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)}${units[unit]}`;
}

/**
 * The human table: class, path, size, branch/HEAD, action and reason.
 *
 * @param {object} result the `runCleanWorktrees` envelope
 * @returns {string}
 */
export function renderTable(result) {
  const rows = result.entries.map((e) => [
    e.class ?? 'kept',
    path.relative(result.projectRoot, e.path) || '.',
    formatBytes(e.sizeBytes),
    e.branch ?? (e.head ? `(detached ${e.head.slice(0, 7)})` : '-'),
    e.reason ? `${e.action}: ${e.reason}` : e.action,
  ]);
  const header = ['CLASS', 'PATH', 'SIZE', 'BRANCH/HEAD', 'ACTION'];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const footer =
    result.mode === 'dry-run'
      ? 'Dry run — nothing removed. Re-run with --execute to remove candidates.'
      : `Reclaimed ${formatBytes(result.bytesReclaimed)}.`;
  return [line(header), ...rows.map(line), '', footer].join('\n');
}

async function promptConfirm(entry) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Remove ${entry.class} worktree ${entry.path}? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * CLI core: parse argv, run, render.
 *
 * @param {string[]} [argv]
 * @param {{ runImpl?: typeof runCleanWorktrees, write?: (text: string) => void, isTTY?: boolean }} [deps]
 * @returns {Promise<object|undefined>}
 */
export async function runCleanWorktreesCli(
  argv = process.argv.slice(2),
  {
    runImpl = runCleanWorktrees,
    write = writeStdout,
    isTTY = process.stdin.isTTY === true,
  } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      execute: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    write(HELP);
    return undefined;
  }
  const result = await runImpl({
    cwd: values.cwd,
    execute: values.execute,
    yes: values.yes,
    confirm: isTTY && !values.json ? promptConfirm : null,
  });
  write(values.json ? JSON.stringify(result, null, 2) : renderTable(result));
  return result;
}

runAsCli(import.meta.url, () => runCleanWorktreesCli(), {
  source: 'clean-worktrees',
  usage: HELP,
});
