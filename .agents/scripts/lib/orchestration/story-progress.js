/**
 * The live story-progress record: which handoff step or close
 * phase a Story is in right now, so live tooling can see the post-validation
 * close phases that otherwise leave nothing on disk until the terminal
 * envelope. Shape: `.agents/schemas/story-progress.schema.json`.
 *
 * Advisory only — nothing in Mandrel decides on it. Every write is best
 * effort (an fs error is swallowed and logged at debug) and atomic (a
 * `<file>.tmp` sibling renamed over the target), so a poller never parses
 * half a file and an unwritable temp folder changes no delivery outcome.
 */

import fs from 'node:fs';
import path from 'node:path';

import { storyProgressPath } from '../config/temp-paths.js';
import { Logger } from '../Logger.js';

export const STORY_PROGRESS_KIND = 'story-progress';

/** The two stages that write the record. */
export const STORY_PROGRESS_STAGES = Object.freeze(['handoff', 'close']);

/**
 * A handoff step's reported name from its function name: `stepBaseMerge` →
 * `base-merge`. The handoff suite pins that these equal the names each step
 * reports in its envelope.
 *
 * @param {Function} step
 * @returns {string}
 */
export function handoffStepName(step) {
  return step.name
    .replace(/^step/, '')
    .replace(/[A-Z]/g, (c, i) => `${i > 0 ? '-' : ''}${c.toLowerCase()}`);
}

/**
 * Write `record` to `file` atomically. Never throws.
 *
 * @param {string} file
 * @param {object} record
 * @param {{ fsImpl?: typeof fs, debug?: (msg: string) => void }} [deps]
 * @returns {boolean} whether the record landed
 */
export function writeStoryProgress(file, record, deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  const debug = deps.debug ?? ((msg) => Logger.debug(msg));
  const tmp = `${file}.tmp`;
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      fsImpl.rmSync(tmp, { force: true });
    } catch {
      // The stray tmp is harmless; the next write overwrites it.
    }
    debug(`[story-progress] write skipped for ${file}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * A per-run recorder: `stageStartedAt` is fixed at creation, `phaseStartedAt`
 * resets on each `phase()`, and `prNumber()` re-writes the current phase with
 * the PR number once known. Nothing is written until the first `phase()`.
 * Construction never throws either: a bad Story id or config degrades to a
 * recorder that writes nothing.
 *
 * @param {{ storyId: number, stage: 'handoff'|'close', config?: object,
 *   file?: string, now?: () => Date, fsImpl?: typeof fs,
 *   debug?: (msg: string) => void }} args
 * @returns {{ phase: (name: string) => boolean, prNumber: (n: number|null) => boolean, file: string|null }}
 */
export function createStoryProgress({
  storyId,
  stage,
  config,
  file,
  now = () => new Date(),
  fsImpl,
  debug,
}) {
  let target = file ?? null;
  if (!target) {
    try {
      target = storyProgressPath(storyId, config);
    } catch (err) {
      (debug ?? ((msg) => Logger.debug(msg)))(
        `[story-progress] no progress path: ${err?.message ?? err}`,
      );
    }
  }
  const stageStartedAt = now().toISOString();
  let current = null;
  let phaseStartedAt = stageStartedAt;
  let pr = null;
  const write = () => {
    if (!target || current === null) return false;
    return writeStoryProgress(
      target,
      {
        kind: STORY_PROGRESS_KIND,
        storyId,
        stage,
        phase: current,
        stageStartedAt,
        phaseStartedAt,
        prNumber: pr,
        updatedAt: now().toISOString(),
      },
      { fsImpl, debug },
    );
  };
  return {
    file: target,
    phase(name) {
      current = name;
      phaseStartedAt = now().toISOString();
      return write();
    },
    prNumber(n) {
      pr = Number.isInteger(n) && n > 0 ? n : null;
      return write();
    },
  };
}
