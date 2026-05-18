/**
 * stashes.js — stash-triage phase of git-cleanup (Story #2466).
 *
 * Owns `parseStashList`, `planStashes`, `executeStashes`, `stashRefIndex`,
 * and `buildAllowlistDecider`. Extracted verbatim from `git-cleanup.js`.
 *
 * @module lib/orchestration/git-cleanup/phases/stashes
 */

import { gitSpawn } from '../../../git-utils.js';
import { Logger } from '../../../Logger.js';
import { dropStash } from './git-probes.js';

const TAG = '[git-cleanup]';

/**
 * Pure: parse `git stash list --format='%gd|%ci|%s'` output into
 * structured stash entries.
 */
export function parseStashList(stdout) {
  const out = [];
  for (const raw of (stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf('|');
    if (idx < 0) continue;
    const ref = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1);
    const idx2 = rest.indexOf('|');
    if (idx2 < 0) continue;
    const createdAt = rest.slice(0, idx2).trim();
    const message = rest.slice(idx2 + 1).trim();
    if (!ref) continue;
    out.push({ ref, createdAt, message });
  }
  return out;
}

/* node:coverage ignore next */
function listStashes(cwd) {
  const res = gitSpawn(cwd, 'stash', 'list', '--format=%gd|%ci|%s');
  if (res.status !== 0) return [];
  return parseStashList(res.stdout);
}

/** Plan the stash phase: enumerate stashes, no mutation. */
export function planStashes(ctx) {
  const { cwd, stashListerFn = listStashes } = ctx;
  return { stashes: stashListerFn(cwd) };
}

/**
 * Pure: extract the numeric index from a stash ref like `stash@{3}`.
 */
export function stashRefIndex(ref) {
  const m = /^stash@\{(\d+)\}$/.exec(ref ?? '');
  return m ? Number(m[1]) : -1;
}

/**
 * Build a non-interactive `decideFn` that drops stashes whose refs
 * appear in `allowlist`, and keeps every other stash. Used in JSON /
 * --yes mode.
 */
export function buildAllowlistDecider(allowlist) {
  const set = new Set(allowlist ?? []);
  return (entry) => (set.has(entry.ref) ? 'drop' : 'keep');
}

function applyDecision({
  s,
  decideFn,
  dropFn,
  cwd,
  actions,
  failures,
  logger,
}) {
  const decision = decideFn(s);
  if (decision === 'quit') {
    actions.push({ ref: s.ref, action: 'quit' });
    return { quit: true };
  }
  if (decision === 'keep') {
    actions.push({ ref: s.ref, action: 'keep' });
    return { quit: false };
  }
  const res = dropFn(s.ref, cwd);
  if (res.ok) {
    logger.info?.(`${TAG} ✅ dropped ${s.ref}: ${s.message}`);
    actions.push({ ref: s.ref, action: 'drop', dropped: true });
  } else {
    logger.warn?.(`${TAG} ❌ drop ${s.ref} failed: ${res.stderr}`);
    actions.push({
      ref: s.ref,
      action: 'drop',
      dropped: false,
      stderr: res.stderr,
    });
    failures.push({ ref: s.ref, stderr: res.stderr });
  }
  return { quit: false };
}

/**
 * Execute the stash phase. Dispatches per-stash via the injected
 * `decideFn` so interactive prompts (readline) and non-interactive
 * allowlists (`--drop-stashes <ref>`) share the same engine.
 */
export function executeStashes(ctx) {
  const { cwd, stashes, decideFn, dropFn = dropStash, logger = Logger } = ctx;
  const actions = [];
  const failures = [];
  let quit = false;
  // Drop stashes high-index-first so the indices of remaining stashes
  // stay stable across calls — git renumbers from the top of the stack.
  const ordered = [...stashes].sort(
    (a, b) => stashRefIndex(b.ref) - stashRefIndex(a.ref),
  );
  for (const s of ordered) {
    if (quit) {
      actions.push({ ref: s.ref, action: 'quit' });
      continue;
    }
    const out = applyDecision({
      s,
      decideFn,
      dropFn,
      cwd,
      actions,
      failures,
      logger,
    });
    if (out.quit) quit = true;
  }
  return { ok: failures.length === 0, actions, failures };
}
