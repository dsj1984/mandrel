/**
 * The dispatch record: what `--stop` needs to find a launched delivery
 * (`pid`) and what an operator needs to follow it (`logPath`). Written beside
 * the log under the project temp root.
 *
 * @module lib/dispatch/record
 */

import fs from 'node:fs';

import { dispatchRecordPath } from '../config/temp-paths.js';

/**
 * @typedef {{ storyId: number, environment: string, pid: number,
 *   startedAt: string, logPath: string, argv: string[] }} DispatchRecord
 */

/**
 * @param {DispatchRecord} record
 * @param {{ config?: object, fsImpl?: typeof fs }} [opts]
 * @returns {string} The record path.
 */
export function writeRecord(record, { config, fsImpl = fs } = {}) {
  const file = dispatchRecordPath(record.storyId, config);
  fsImpl.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}

/**
 * The Story's record, or `null` when none was written or it is unreadable.
 *
 * @param {number} storyId
 * @param {{ config?: object, fsImpl?: typeof fs }} [opts]
 * @returns {DispatchRecord|null}
 */
export function readRecord(storyId, { config, fsImpl = fs } = {}) {
  try {
    return JSON.parse(
      fsImpl.readFileSync(dispatchRecordPath(storyId, config), 'utf8'),
    );
  } catch {
    return null;
  }
}

/**
 * @param {number} storyId
 * @param {{ config?: object, fsImpl?: typeof fs }} [opts]
 */
export function removeRecord(storyId, { config, fsImpl = fs } = {}) {
  fsImpl.rmSync(dispatchRecordPath(storyId, config), { force: true });
}
