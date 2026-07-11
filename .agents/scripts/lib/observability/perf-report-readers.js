/**
 * perf-report-readers.js — I/O readers + git-scrape helpers for the
 * structured perf-summary comments (Epic #1030 / Story #1123, split out
 * under Story #3350).
 *
 * Every export here touches the filesystem, the ticketing provider, or
 * `git log`. The pure renderers that format the report bodies live in the
 * sibling `perf-report-render.js`; the Story-/Epic-mode orchestrators in
 * `analyze-execution.js` wire these readers to those renderers.
 *
 * @see docs/data-dictionary.md §StoryPerfSummary, §EpicPerfReport
 */

import fs from 'node:fs/promises';
import { storyArtifactPath } from '../config/temp-paths.js';
import { gitSpawn } from '../git-utils.js';
import { Logger } from '../Logger.js';
import { read as readSignals } from '../signals/read.js';
import { concurrentMap } from '../util/concurrent-map.js';
import { extractStoryPerfSummaryFromComment } from './perf-report-render.js';
import { forEachLine } from './signals-writer.js';

/**
 * Stream every lifecycle event under the Epic into an in-memory array
 * (Story #3025 / Task #3030). The perf-aggregator's wave-parallelism
 * reducer needs a single chronological iterable spanning wave-start /
 * wave-complete / state-transition events; the canonical reader walks
 * the epic-level signals.ndjson first, then each per-Story stream in
 * ascending Story-ID order, so that ordering matches the wave-tick
 * emit order at runtime.
 *
 * Returns `[]` on any reader failure so the analyzer keeps composing
 * its other report sections.
 */
export async function readEpicLifecycleEvents(epicId, config, logger) {
  const events = [];
  try {
    for await (const evt of readSignals({ epic: epicId, config })) {
      if (evt && typeof evt === 'object') events.push(evt);
    }
  } catch (err) {
    logger?.warn?.(
      `[analyze-execution] readEpicLifecycleEvents(${epicId}) failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return events;
}

/**
 * Read every NDJSON line from a Story's signals stream into an array.
 * Missing files resolve to `[]` so callers can treat absence as
 * "no signals yet" without a try/catch.
 */
export async function readStorySignals(epicId, storyId, config) {
  const events = [];
  await forEachLine(
    epicId,
    storyId,
    (parsed) => {
      if (parsed && typeof parsed === 'object') events.push(parsed);
    },
    config,
  );
  return events;
}

/**
 * Best-effort read of the per-Story phase-timings JSON written by
 * `post-merge-close.js`. Returns `null` when the file is missing or
 * malformed — phaseTimingsMs in the StoryPerfSummary degrades to `{}`
 * rather than throwing.
 */
export async function readPhaseTimings(epicId, storyId, config, overridePath) {
  const target =
    overridePath ??
    storyArtifactPath(epicId, storyId, 'phase-timings.json', config);
  try {
    const buf = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    Logger.warn(
      `[analyze-execution] could not parse phase-timings at ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Throw-away ghSpawnCount reader (Story #1795 / Epic #1788). Looks for
 * the `temp/epic-<eid>/stories/story-<sid>/gh-spawn-count.json` file written by
 * `close-validation.emitGhSpawnCount` immediately before the perf-summary
 * phase spawns this analyzer. Returns the integer count when present and
 * well-formed; `null` when absent or unparseable. Callers treat `null` as
 * "no signal" — the structured comment simply omits `ghSpawnCount`.
 */
export async function readGhSpawnCount(epicId, storyId, config) {
  const target = storyArtifactPath(
    epicId,
    storyId,
    'gh-spawn-count.json',
    config,
  );
  try {
    const buf = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(buf);
    const count = parsed?.ghSpawnCount;
    if (Number.isInteger(count) && count >= 0) return count;
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    Logger.warn(
      `[analyze-execution] could not parse gh-spawn-count at ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Fetch every `story-perf-summary` structured comment from the Stories
 * under an Epic. We rely on `provider.getSubTickets(epicId)` for child
 * enumeration (Stories carry `parent: #<epicId>` either via the native
 * sub-issue link or the body marker — `getSubTickets` reconciles both).
 * Missing comments are skipped (the Story may have been recut and not
 * closed yet).
 */
export async function collectStorySummaries(provider, epicId, logger) {
  let stories;
  try {
    const children = await provider.getSubTickets(epicId);
    stories = Array.isArray(children) ? children : [];
  } catch (err) {
    logger.warn?.(
      `[analyze-execution] getSubTickets(${epicId}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  // Filter to Story tickets — descendants include Tasks too. We only
  // want the per-Story summaries, so guard on `type::story`.
  const storyTickets = stories.filter(
    (t) =>
      Array.isArray(t?.labels) &&
      t.labels.some(
        (l) => (typeof l === 'string' ? l : l?.name) === 'type::story',
      ),
  );

  // Bounded-parallel comment fetch (Story #3990). Each Story's comment
  // thread is an independent paginated REST read through a fresh `gh`
  // spawn, so a serial loop pays N sequential round-trips. concurrentMap
  // preserves input→output index, keeping summaries in Story order; the
  // per-Story try/catch stays inside the mapper so one failed fetch
  // degrades to warn-and-skip without aborting the batch (mirrors
  // verifySingleResult in lib/orchestration/wave-record-io.js, #3024).
  const perStory = await concurrentMap(
    storyTickets,
    async (ticket) => {
      const id = Number(ticket.id ?? ticket.number);
      if (!Number.isInteger(id) || id < 1) return null;
      let comments;
      try {
        comments = (await provider.getTicketComments(id)) ?? [];
      } catch (err) {
        logger.warn?.(
          `[analyze-execution] getTicketComments(${id}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
      for (const c of comments) {
        const parsed = extractStoryPerfSummaryFromComment(c?.body);
        if (parsed) return parsed;
      }
      return null;
    },
    { concurrency: 4 },
  );
  return perStory.filter((s) => s !== null);
}

/**
 * Default git-log gatherer for the baseline-refresh-rate reporter
 * (Story #1400 / Task #1427). Reads commits on `epic/<id>` over the
 * trailing window and shapes them into the record format the pure
 * reporter expects. Returns `[]` on any spawn failure so the retro
 * comment keeps composing — the reporter then prints "no Story merges
 * in window" and the operator can investigate offline.
 *
 * Injectable via `runEpicMode({ gatherEpicCommitsFn })` so the unit test
 * can pin behavior without a temp git repo.
 */
export function gatherEpicCommitsFromGit({ epicId, windowDays, cwd, logger }) {
  const ref = `epic/${epicId}`;
  const since = `${windowDays} days ago`;
  // Subject (%s) carries the Story-merge `(resolves #N)` and the
  // `baseline-refresh:` prefix; ISO commit date (%cI) drives the window
  // filter inside the reporter. Tab separator avoids subjects that
  // contain pipes.
  const res = gitSpawn(
    cwd,
    'log',
    ref,
    `--since=${since}`,
    '--pretty=format:%H%x09%cI%x09%s',
  );
  if (res.status !== 0) {
    logger.warn?.(
      `[analyze-execution] git log ${ref} failed (non-fatal): ${res.stderr || res.stdout}`,
    );
    return [];
  }
  const lines = (res.stdout || '').split('\n').filter(Boolean);
  return lines.map((line) => {
    const [sha, isoDate, ...rest] = line.split('\t');
    return {
      sha,
      isoDate,
      subject: rest.join('\t'),
      epicId,
    };
  });
}

/**
 * Default friction aggregator for the Quality-gate friction block
 * (Story #1400 / Task #1429). Walks each child Story's signals.ndjson
 * stream and returns counts of `baseline-refresh-regression` records
 * plus the top offenders by file (and method, when present in the
 * `regressedFiles` / `crapOverCap` payloads).
 *
 * Aggregation runs against the existing `signals.ndjson` stream — no new
 * file format. Two upstream record shapes are walked:
 *   - check-maintainability emits a flat `regressedFiles[]` of `{ file, current, baseline, drop }`.
 *   - auto-refresh-runner emits `miOverCap[]` / `crapOverCap[]` rows
 *     carrying `path`/`file` and (for crap) `method`.
 *
 * Injectable via `runEpicMode({ aggregateFrictionFn })` so the unit test
 * can pin behavior without seeding NDJSON files.
 */
export async function aggregateBaselineFrictionFromSignals({
  epicId,
  storyIds,
  config,
  windowDays,
  now,
}) {
  const cutoffMs = now().getTime() - windowDays * 24 * 60 * 60 * 1000;
  const offenders = new Map(); // key → { file, method, occurrences }
  const storiesAffected = new Set();
  let totalRecords = 0;

  for (const sid of storyIds) {
    let touched = false;
    await forEachLine(
      epicId,
      sid,
      (record) => {
        if (
          !record ||
          typeof record !== 'object' ||
          record.kind !== 'friction' ||
          record.category !== 'baseline-refresh-regression'
        ) {
          return;
        }
        const ts = Date.parse(record.ts);
        if (Number.isFinite(ts) && ts < cutoffMs) return;

        totalRecords += 1;
        touched = true;

        const flatFiles = Array.isArray(record.regressedFiles)
          ? record.regressedFiles.map((r) => ({ file: r.file }))
          : [];
        const miFiles = Array.isArray(record.miOverCap)
          ? record.miOverCap.map((r) => ({ file: r.path ?? r.file }))
          : [];
        const crapMethods = Array.isArray(record.crapOverCap)
          ? record.crapOverCap.map((r) => ({
              file: r.file,
              method: r.method,
            }))
          : [];

        for (const off of [...flatFiles, ...miFiles, ...crapMethods]) {
          if (!off || typeof off.file !== 'string' || off.file.length === 0) {
            continue;
          }
          const key = off.method ? `${off.file}::${off.method}` : off.file;
          const prev = offenders.get(key);
          if (prev) {
            prev.occurrences += 1;
          } else {
            offenders.set(key, {
              file: off.file,
              method: off.method ?? null,
              occurrences: 1,
            });
          }
        }
      },
      config,
    );
    if (touched) storiesAffected.add(sid);
  }

  const topOffenders = [...offenders.values()]
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 10);

  return {
    totalRecords,
    storiesAffected: storiesAffected.size,
    topOffenders,
    windowDays,
  };
}
