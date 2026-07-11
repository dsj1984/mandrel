#!/usr/bin/env node

/**
 * standalone-feedback-rollup.js — end-of-run feedback rollup for the
 * `/deliver` standalone multi-Story path (Epic #4406 / Story #4416).
 *
 * The standalone delivery path (`helpers/deliver-stories`) drives one or
 * more Epic-free Stories to green, and each per-Story sub-agent appends
 * `friction` records to its **standalone** signals stream at
 * `temp/standalone/stories/story-<sid>/signals.ndjson` (written via
 * `appendSignal({ epicId: null, storyId })`). Before this rollup that
 * tree was write-only — nothing ever read it back. This CLI closes the
 * gap: it scans the standalone streams for the delivered Story set and
 * emits a per-category friction summary that `deliver-stories.md`
 * surfaces in its Phase 3 run summary.
 *
 * Usage:
 *   node standalone-feedback-rollup.js --stories <id,...>
 *
 * Contract:
 *   - Stream paths resolve **exclusively** through the `temp-paths`
 *     helpers via `forEachLine(null, storyId, cb, config)` — the `null`
 *     Epic sentinel routes to the standalone tree. No hand-built path
 *     strings.
 *   - Aggregates `friction` records by their **top-level** `category`
 *     (Epic #4406 canonical envelope shape); a record with no category
 *     buckets under `Unknown`.
 *   - **Never fails a run.** A missing or empty stream degrades to an
 *     empty contribution; the CLI always prints a JSON summary and
 *     exits 0. Observability MUST NOT take down the delivering flow.
 *
 * Output (stdout, one JSON object):
 *   {
 *     "kind": "standalone-feedback-rollup",
 *     "stories": [<id>, ...],
 *     "totalFriction": <int>,
 *     "byCategory": { "<category>": <count>, ... },
 *     "perStory": { "<id>": { "friction": <int>, "missing": <bool> }, ... }
 *   }
 *
 * @see .agents/scripts/lib/observability/signals-writer.js (forEachLine, appendSignal)
 * @see .agents/scripts/lib/config/temp-paths.js (signalsFile — null Epic sentinel)
 * @see .agents/workflows/helpers/deliver-stories.md (Phase 3 summary wiring)
 */

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { forEachLine } from './lib/observability/signals-writer.js';

const FRICTION_KIND = 'friction';
const UNKNOWN_CATEGORY = 'Unknown';

/**
 * Parse `--stories <id,...>` into an ordered, de-duplicated array of
 * positive-integer Story IDs. Accepts a single comma-separated value or
 * repeated `--stories` flags. Non-integer / non-positive tokens are
 * rejected so a typo surfaces as an input error rather than a silently
 * empty rollup.
 *
 * @param {string[]} args
 * @returns {{ stories: number[] }}
 */
export function parseArguments(args) {
  const raw = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stories') {
      const value = args[++i];
      if (typeof value === 'string') {
        raw.push(...value.split(','));
      }
    }
  }

  const seen = new Set();
  const stories = [];
  for (const token of raw) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `--stories expects comma-separated positive integers; got ${JSON.stringify(trimmed)}`,
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    stories.push(id);
  }

  if (stories.length === 0) {
    throw new Error(
      'Usage: node standalone-feedback-rollup.js --stories <id,...>',
    );
  }

  return { stories };
}

/**
 * Read one standalone Story's signals stream and aggregate its `friction`
 * records by top-level `category`, mutating the shared `byCategory` tally.
 *
 * Degrades to a zero contribution on a missing / empty / unreadable
 * stream — `forEachLine` already swallows fs + JSON faults and reports a
 * missing file via `{ missing: true }` rather than throwing.
 *
 * @param {number} storyId
 * @param {Record<string, number>} byCategory Mutated in place.
 * @param {object} config
 * @returns {Promise<{ friction: number, missing: boolean }>}
 */
async function rollupStory(storyId, byCategory, config) {
  let friction = 0;
  // `epicId: null` routes forEachLine → signalsFile(null, storyId, config)
  // → the standalone tree. Never a hand-built path string.
  const result = await forEachLine(
    null,
    storyId,
    (record) => {
      if (
        record === null ||
        typeof record !== 'object' ||
        record.kind !== FRICTION_KIND
      ) {
        return;
      }
      const category =
        typeof record.category === 'string' && record.category.length > 0
          ? record.category
          : UNKNOWN_CATEGORY;
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      friction += 1;
    },
    config,
  );

  return { friction, missing: Boolean(result?.missing) };
}

/**
 * Aggregate friction across every named standalone Story stream.
 *
 * @param {number[]} stories
 * @param {object} [config]
 * @returns {Promise<{
 *   kind: string,
 *   stories: number[],
 *   totalFriction: number,
 *   byCategory: Record<string, number>,
 *   perStory: Record<string, { friction: number, missing: boolean }>,
 * }>}
 */
export async function buildRollup(stories, config) {
  const byCategory = {};
  const perStory = {};
  let totalFriction = 0;

  for (const storyId of stories) {
    const { friction, missing } = await rollupStory(
      storyId,
      byCategory,
      config,
    );
    perStory[storyId] = { friction, missing };
    totalFriction += friction;
  }

  return {
    kind: 'standalone-feedback-rollup',
    stories,
    totalFriction,
    byCategory,
    perStory,
  };
}

export async function main(args = process.argv.slice(2)) {
  const { stories } = parseArguments(args);
  const config = resolveConfig();
  const summary = await buildRollup(stories, config);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'StandaloneFeedbackRollup',
  propagateExitCode: true,
});
