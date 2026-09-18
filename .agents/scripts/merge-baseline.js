#!/usr/bin/env node

/**
 * merge-baseline.js — git merge driver for `baselines/*.json`.
 *
 * A text merge of a baseline conflicts on rows adjacent in sort order or
 * appended at the tail, and can splice both sides' rows into a set no scorer
 * produced. This merges rows by identity instead. The committed shape carries
 * no stamp or rollup, so disjoint non-adjacent refreshes also merge textually
 * where this driver never runs (GitHub). Files that are not a known row
 * baseline go to `git merge-file` unchanged.
 *
 *   node .agents/scripts/merge-baseline.js %O %A %B %P
 *
 * `%A` is ours and MUST hold the result. Exit 0 clean, non-zero conflicted.
 * Registration is per-clone git config, so `mandrel doctor` guards it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertEnvelope } from './lib/baselines/envelope.js';
import {
  baselineRegenerateRemedy,
  kindFromEnvelope,
  mergeEnvelopes,
  mergePlainBaseline,
  plainKindFromEnvelope,
  renderStampConflict,
} from './lib/baselines/merge-envelopes.js';
import { writeFile as writeEnvelopeFile } from './lib/baselines/writer.js';
import {
  BASELINE_MERGE_DRIVER_REMEDY,
  ensureBaselineMergeDriver,
} from './lib/bootstrap/baseline-merge-driver.js';
import { spawnChild } from './lib/child-exec.js';
import { runAsCli } from './lib/cli-utils.js';

/** Indent one row's canonical JSON to its position inside `rows`. */
function rowBlock(row) {
  return JSON.stringify(row, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * Wrap each conflicting row in markers within the canonical text, so the rest
 * is byte-identical to a clean merge.
 *
 * @param {string} text
 * @param {Array<object>} conflicts
 * @returns {string}
 */
export function renderConflictMarkers(text, conflicts) {
  let out = text;
  for (const conflict of conflicts) {
    const placed = conflict.ours ?? conflict.theirs;
    if (placed === undefined) continue;
    const block = rowBlock(placed);
    // Keep the row's trailing separator (if any) so markers wrap whole lines.
    const withComma = `${block},`;
    const [needle, suffix] = out.includes(withComma)
      ? [withComma, ',']
      : [block, ''];
    if (!out.includes(needle)) continue;
    const ourSide =
      conflict.ours === undefined
        ? ''
        : `${rowBlock(conflict.ours)}${suffix}\n`;
    const theirSide =
      conflict.theirs === undefined
        ? ''
        : `${rowBlock(conflict.theirs)}${suffix}\n`;
    out = out.replace(
      needle,
      `<<<<<<< ours\n${ourSide}=======\n${theirSide}>>>>>>> theirs`.replace(
        /\n$/,
        '',
      ),
    );
  }
  return out;
}

/** Read and parse a merge input; a missing or empty side is `null`. */
function readSide(file) {
  if (!file || !fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // present but unparseable — caller falls back to git
  }
}

/**
 * Fall back to git's text merge for unknown or unparseable files; the driver
 * never invents a result.
 *
 * @returns {number} git merge-file's own exit code.
 */
function delegateToGit(basePath, oursPath, theirsPath) {
  // A null status means the child was killed — never a clean merge.
  const result = spawnChild(
    'git',
    ['merge-file', oursPath, basePath, theirsPath],
    { stdio: 'inherit' },
  );
  if (result.error) {
    process.stderr.write(
      `merge-baseline: could not run git merge-file: ${result.error.message}\n`,
    );
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Envelope kinds or plain row baselines (cyclomatic,
 * dead-exports*); anything else resolves `null` and goes back to git.
 *
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {{ kind: string, envelopeKind: boolean }|null}
 */
function resolveMergeTarget(ours, theirs) {
  const envelopeKind = kindFromEnvelope(ours) ?? kindFromEnvelope(theirs);
  if (envelopeKind) return { kind: envelopeKind, envelopeKind: true };
  const plain = plainKindFromEnvelope(ours) ?? plainKindFromEnvelope(theirs);
  if (plain) return { kind: plain, envelopeKind: false };
  return null;
}

/**
 * Plain baselines use their generators' exact serialization so a clean merge
 * is byte-identical to a regeneration.
 *
 * @param {string} oursPath
 * @param {{ envelope: object }} merged
 * @param {boolean} isEnvelopeKind
 */
function writeMerged(oursPath, merged, isEnvelopeKind) {
  if (isEnvelopeKind) {
    writeEnvelopeFile(oursPath, merged.envelope);
    return;
  }
  fs.writeFileSync(oursPath, `${JSON.stringify(merged.envelope, null, 2)}\n`);
}

/**
 * `--install`: the per-clone git config does not travel with the repo and its
 * absence is silent, so `prepare` runs this (idempotent).
 *
 * @returns {number} Process exit code.
 */
function runInstall() {
  const result = ensureBaselineMergeDriver({ projectRoot: process.cwd() });
  if (result.config === 'failed') {
    process.stderr.write(
      `merge-baseline: could not register the merge driver.\n  → ${BASELINE_MERGE_DRIVER_REMEDY}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `merge-baseline: driver ${result.action} (attributes=${result.attributes}, config=${result.config}) → ${result.command}\n`,
  );
  return 0;
}

/**
 * @param {string[]} argv Positional arguments: %O %A %B [%P].
 * @returns {number} Process exit code.
 */
export function runMergeBaseline(argv) {
  if (argv.includes('--install')) return runInstall();
  const [baseArg, oursArg, theirsArg, mergedPath] = argv;
  if (!baseArg || !oursArg || !theirsArg) {
    process.stderr.write(
      'merge-baseline: expected the git merge-driver arguments %O %A %B %P\n',
    );
    return 2;
  }

  // Git passes worktree-relative temp names; the shared writer refuses
  // relative paths.
  const [basePath, oursPath, theirsPath] = [baseArg, oursArg, theirsArg].map(
    (p) => path.resolve(p),
  );

  const ours = readSide(oursPath);
  const theirs = readSide(theirsPath);
  const target =
    ours === undefined || theirs === undefined
      ? null
      : resolveMergeTarget(ours, theirs);
  if (!target) return delegateToGit(basePath, oursPath, theirsPath);

  return mergeResolved({
    target,
    base: readSide(basePath),
    ours,
    theirs,
    basePath,
    oursPath,
    theirsPath,
    label: mergedPath || oursPath,
  });
}

/**
 * A merge that throws is handed back to git rather than half-written.
 *
 * @param {object} ctx
 * @returns {number} Process exit code.
 */
function mergeResolved({
  target,
  base,
  ours,
  theirs,
  basePath,
  oursPath,
  theirsPath,
  label,
}) {
  const { kind, envelopeKind: isEnvelopeKind } = target;
  let merged;
  try {
    merged = isEnvelopeKind
      ? mergeEnvelopes({ base, ours, theirs, kind })
      : mergePlainBaseline({ base, ours, theirs, kind });
  } catch (err) {
    process.stderr.write(`merge-baseline: ${kind}: ${err.message}\n`);
    return delegateToGit(basePath, oursPath, theirsPath);
  }

  // Written even when conflicted: markers are rendered onto these bytes.
  writeMerged(oursPath, merged, isEnvelopeKind);

  if (merged.conflicts.length === 0) {
    if (isEnvelopeKind) assertEnvelope(merged.envelope);
    return 0;
  }
  return markConflicts({ kind, merged, oursPath, label });
}

/**
 * Both row and envelope conflicts get in-file markers, so the file never
 * looks cleanly merged while git holds it unmerged.
 *
 * @param {{ kind: string, merged: object, oursPath: string, label: string }} ctx
 * @returns {number} Always 1.
 */
function markConflicts({ kind, merged, oursPath, label }) {
  const rowConflicts = merged.conflicts.filter((c) => c.scope === 'row');
  const envelopeConflicts = merged.conflicts.filter(
    (c) => c.scope === 'envelope',
  );
  reportConflicts({ kind, label, rowConflicts, envelopeConflicts });

  let text = fs.readFileSync(oursPath, 'utf8');
  if (envelopeConflicts.length > 0) {
    text = renderStampConflict(text, envelopeConflicts);
  }
  if (rowConflicts.length > 0) {
    text = renderConflictMarkers(text, rowConflicts);
  }
  fs.writeFileSync(oursPath, text);
  return 1;
}

/**
 * Names the regenerate command: hand-resolved rows describe a tree nobody
 * scored.
 *
 * @param {{ kind: string, label: string, rowConflicts: Array<object>, envelopeConflicts: Array<object> }} args
 */
function reportConflicts({ kind, label, rowConflicts, envelopeConflicts }) {
  for (const conflict of envelopeConflicts) {
    process.stderr.write(
      `merge-baseline: conflict ${kind} envelope key "${conflict.identity}" in ${label} — ours ${JSON.stringify(conflict.ours)}, theirs ${JSON.stringify(conflict.theirs)}\n`,
    );
  }
  for (const conflict of rowConflicts) {
    process.stderr.write(
      `merge-baseline: conflict ${kind} row "${conflict.identity}" in ${label}\n`,
    );
  }
  process.stderr.write(
    `merge-baseline: ${label} is conflicted — hand-resolved rows describe a ` +
      `tree nobody scored. After resolving the markers, regenerate it: ` +
      `${baselineRegenerateRemedy(kind)}\n`,
  );
}

function main() {
  return runMergeBaseline(process.argv.slice(2));
}

runAsCli(import.meta.url, main, {
  source: 'merge-baseline',
  propagateExitCode: true,
  usage: {
    invocation: 'node .agents/scripts/merge-baseline.js %O %A %B %P',
    summary:
      'Git merge driver for baselines/*.json. Merges per-kind envelopes by ROW IDENTITY — disjoint refreshes merge clean even where their rows are adjacent, and a row both sides changed differently conflicts. A baselines file that is not a known per-kind envelope is handed back to git merge-file unchanged. Exit 0 clean, 1 conflicted.',
    flags: [
      ['%O', 'Merge ancestor (git supplies this).'],
      ['%A', 'Our version — the driver writes its result here.'],
      ['%B', 'Their version.'],
      ['%P', 'Real pathname being merged; used in conflict messages.'],
      [
        '--install',
        'Register the driver in this clone (.gitattributes line + the per-clone merge.mandrel-baseline.driver config) and exit. Idempotent.',
      ],
    ],
  },
});
