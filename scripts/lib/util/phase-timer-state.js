/**
 * lib/util/phase-timer-state.js — Cross-process persistence for phase-timer
 *
 * A Story Mode run spans two Node processes — `story-init` creates the
 * timer and opens the `implement` phase; the operator (or a headless
 * `claude -p` sub-agent) does the work; `story-close` reads the
 * timer back, appends `lint` / `test` / `close` / `api-sync` marks, and
 * emits the `phase-timings` structured comment.
 *
 * Snapshots land in the main-repo `.git/` (which every process in the story
 * lifecycle can see — init writes from the main checkout, close invokes with
 * `--cwd <main-repo>` per the worktree contract). `.git/` is deliberately
 * chosen over the worktree root so the file is never accidentally checked
 * into the story branch and never ships in a PR.
 */

import fs from 'node:fs';
import path from 'node:path';

function filePath(mainCwd, storyId) {
  return path.join(mainCwd, '.git', `story-${storyId}-phase-timer.json`);
}

/**
 * Persist the current timer snapshot to disk. Writes atomically via a
 * temp-file rename so a crash mid-write cannot leave a truncated JSON file
 * that the close process would fail to parse.
 *
 * @param {{ snapshot: () => object }} timer
 * @param {{ mainCwd: string, storyId: number }} opts
 */
export function savePhaseTimerState(timer, { mainCwd, storyId }) {
  const target = filePath(mainCwd, storyId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(timer.snapshot(), null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * Load a timer snapshot from disk if present. Returns `null` when the file
 * is missing or unparseable — both cases are treated as "no prior timer",
 * which lets close fall back to creating a fresh timer and emitting only
 * the phases it observes.
 *
 * @param {{ mainCwd: string, storyId: number }} opts
 * @returns {object | null}
 */
export function loadPhaseTimerState({ mainCwd, storyId }) {
  const p = filePath(mainCwd, storyId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove the on-disk snapshot once the close has consumed it. Missing file
 * is not an error — the close path may run without a prior init (e.g.
 * operator invoking close manually after an init failure).
 *
 * @param {{ mainCwd: string, storyId: number }} opts
 */
export function clearPhaseTimerState({ mainCwd, storyId }) {
  const p = filePath(mainCwd, storyId);
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
