/**
 * planning/spec-authoring-grounding.js — F10 Spec code-grounding.
 *
 * Story #4139 (Epic #4131). `/plan` Phase 7 authors the Tech Spec
 * from the Epic body, the scraped project docs, and the
 * `codebaseSnapshot` structural view of the consumer repo. Two failure
 * modes made that grounding silently partial:
 *
 *   1. The skinny-tier snapshot caps its file list at `MAX_FILES_SKINNY`
 *      and sets `truncated: true` — but the only operator-visible signal
 *      was a stderr `Logger.warn` (Story #3959). The spec author consumes
 *      the JSON envelope, not stderr, so it never learned the snapshot
 *      was partial. A run that dropped "377 of 627 files" looked complete
 *      to the author.
 *
 *   2. When the Epic body cites a code path that is **absent** from the
 *      snapshot's file set, nothing surfaced the gap *during* authoring.
 *      The post-author spec-freshness gate (Story #2635) catches stale
 *      citations only after the Tech Spec is written — one phase too late
 *      to ground the author's choices.
 *
 * `buildAuthoringGrounding` derives a small, bounded `grounding` block that
 * is attached to the `codebaseSnapshot` envelope so the author (and the
 * operator inspecting the run) see both signals before the spec is written:
 *
 *   - `truncation` — non-null when the snapshot dropped files. Carries the
 *     dropped count, the matched/shown totals, and the two remedies. This
 *     is the structured, in-envelope form of the Story #3959 stderr warning.
 *   - `citedButAbsent` — path-shaped references pulled from the authoring
 *     prose (the Epic body) that are **not** present in the snapshot's file
 *     set and are not phrased as net-new. Bounded to `MAX_CITED_ABSENT`
 *     entries so a pathological Epic body cannot blow the envelope budget.
 *
 * The grounding is targeted (the prose the author is grounding *from* and
 * the files the snapshot already carries), not a whole-repo dump — the
 * snapshot file set is the only source consulted, so this adds no new
 * filesystem or git probes.
 */

/**
 * Hard cap on the `citedButAbsent` list so an Epic body that mentions a
 * very large number of paths cannot inflate the authoring envelope. The
 * cap is generous relative to a realistic Epic citation count; when it is
 * hit, `citedButAbsentTruncated: true` flags the elision so the signal is
 * not silently dropped (the very failure mode this Story fixes).
 */
export const MAX_CITED_ABSENT = 40;

/**
 * Build the operator-visible truncation signal from a snapshot envelope.
 * Returns `null` when the snapshot is absent or was not truncated.
 *
 * @param {object|null} snapshot - The `codebaseSnapshot` envelope.
 * @returns {{ dropped: number, matched: number, shown: number, tier: string, remedies: string[] } | null}
 */
export function buildTruncationSignal(snapshot) {
  if (!snapshot || snapshot.truncated !== true) return null;
  const matched = Number.isInteger(snapshot.fileCount) ? snapshot.fileCount : 0;
  const shown = Array.isArray(snapshot.files) ? snapshot.files.length : 0;
  const dropped = Math.max(0, matched - shown);
  return {
    dropped,
    matched,
    shown,
    tier: typeof snapshot.tier === 'string' ? snapshot.tier : 'skinny',
    remedies: [
      'Set planning.codebaseSnapshot.tier: "medium" in .agentrc.json to restore full grounding.',
      'Narrow planning.codebaseSnapshot.include in .agentrc.json so the cited surfaces survive the cap.',
    ],
  };
}

/**
 * Surface path-shaped references from the authoring prose that are absent
 * from the snapshot's file set. Reuses the spec-freshness path extractor so
 * the citation shapes recognised here match the post-author freshness gate
 * exactly — a path the author cites in prose is detected the same way before
 * and after authoring.
 *
 * A reference is reported only when it is **not** present in `snapshotFiles`
 * **and** the surrounding prose does not phrase it as net-new (the same
 * cue heuristic the freshness gate uses to demote intentional new-file
 * mentions). Results are deduped by path, sorted, and bounded to
 * `MAX_CITED_ABSENT`.
 *
 * @param {string} prose - The authoring prose (typically the Epic body).
 * @param {string[]} snapshotFiles - The snapshot's `files` array.
 * @param {object} deps
 * @param {Function} deps.collectReferences - (body) => Array<{ path, index, matchLength }>.
 * @param {Function} deps.hasNewFileCue - (body, index, matchLength) => boolean.
 * @returns {{ paths: string[], truncated: boolean }}
 */
export function findCitedButAbsent(prose, snapshotFiles, deps) {
  const { collectReferences, hasNewFileCue } = deps;
  if (typeof prose !== 'string' || prose.length === 0) {
    return { paths: [], truncated: false };
  }
  const present = new Set(
    (Array.isArray(snapshotFiles) ? snapshotFiles : []).map((f) =>
      String(f).replace(/\\/g, '/'),
    ),
  );
  const absent = new Set();
  for (const { path, index, matchLength } of collectReferences(prose)) {
    const normalised = path.replace(/\\/g, '/');
    if (present.has(normalised)) continue;
    if (hasNewFileCue(prose, index, matchLength)) continue;
    absent.add(normalised);
  }
  const sorted = [...absent].sort();
  return {
    paths: sorted.slice(0, MAX_CITED_ABSENT),
    truncated: sorted.length > MAX_CITED_ABSENT,
  };
}

/**
 * Build the full `grounding` block attached to the `codebaseSnapshot`
 * envelope. Pure with respect to its inputs (no filesystem or git probes):
 * the snapshot file set is the sole grounding source, keeping the context
 * bounded for cost.
 *
 * @param {object} opts
 * @param {object|null} opts.snapshot - The `codebaseSnapshot` envelope.
 * @param {string} opts.prose - The authoring prose (Epic body) to scan.
 * @param {Function} opts.collectReferences - spec-freshness path extractor.
 * @param {Function} opts.hasNewFileCue - spec-freshness net-new cue check.
 * @returns {{ truncation: object|null, citedButAbsent: string[], citedButAbsentTruncated: boolean }}
 */
export function buildAuthoringGrounding({
  snapshot,
  prose,
  collectReferences,
  hasNewFileCue,
}) {
  const truncation = buildTruncationSignal(snapshot);
  const { paths, truncated } = findCitedButAbsent(
    prose,
    snapshot?.files ?? [],
    { collectReferences, hasNewFileCue },
  );
  return {
    truncation,
    citedButAbsent: paths,
    citedButAbsentTruncated: truncated,
  };
}
