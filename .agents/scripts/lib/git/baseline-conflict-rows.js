/**
 * baseline-conflict-rows.js — re-merge one conflicted `baselines/*.json`
 * from its index stages so a row only the Story carries survives a
 * baseline-only base-sync conflict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { decodeEnvelope } from '../baselines/codec.js';
import { mergeBaselineTheirsWins } from '../baselines/merge-envelopes.js';
import { writeFile as writeEnvelopeFile } from '../baselines/writer.js';

/** One index stage, decoded: `null` when absent, `undefined` when undecodable. */
function readStage(gitSpawn, cwd, stage, file) {
  const show = gitSpawn(cwd, 'show', `:${stage}:${file}`);
  if (show.status !== 0) return null;
  try {
    return decodeEnvelope(JSON.parse((show.stdout ?? '').toString()));
  } catch {
    return undefined;
  }
}

/**
 * Row-merge one conflicted baseline from its index stages, the base side
 * winning every conflict. The Story-only row count, or null to fall back.
 */
function keepStoryRows(gitSpawn, cwd, file) {
  const [base, ours, theirs] = [1, 2, 3].map((stage) =>
    readStage(gitSpawn, cwd, stage, file),
  );
  if ([base, ours, theirs].includes(undefined)) return null;
  try {
    const merged = mergeBaselineTheirsWins({ base, ours, theirs });
    if (!merged) return null;
    const abs = path.join(cwd, file);
    if (merged.envelopeKind) writeEnvelopeFile(abs, merged.envelope);
    else fs.writeFileSync(abs, `${JSON.stringify(merged.envelope, null, 2)}\n`);
    return merged.storyOnlyRows;
  } catch {
    return null;
  }
}

/**
 * Row-merge each conflicted baseline in place; `wholeFile` lists the ones
 * that must take `origin/<base>`'s whole file instead.
 *
 * @returns {{ kept: number, wholeFile: string[] }}
 */
export function keepStoryRowsIn(gitSpawn, cwd, files) {
  let kept = 0;
  const wholeFile = [];
  for (const file of files) {
    const rows = keepStoryRows(gitSpawn, cwd, file);
    if (rows === null) wholeFile.push(file);
    else kept += rows;
  }
  return { kept, wholeFile };
}
