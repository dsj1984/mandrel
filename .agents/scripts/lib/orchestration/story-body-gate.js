/**
 * lib/orchestration/story-body-gate.js — the Story-body parse gate
 * (Story #4541), extracted from `ticket-validator.js`: the one place a
 * serialized Story body is parsed with parse failures translated into the
 * validator's operator-legible `ValidationError` shape. Both the gate that
 * refuses a plan up front (`assertStoryBodiesParse`) and the per-call
 * translating parser (`parseStoryBodyOrThrow`) the downstream validators
 * lean on live here.
 */

import { ValidationError } from '../errors/index.js';
import {
  parse as parseStoryBody,
  StoryBodyParseError,
} from '../story-body/story-body.js';

/**
 * Parse a Story's serialized markdown body, translating a
 * `StoryBodyParseError` into a `ValidationError` that names the offending
 * **section** and **entry** (Story #4541).
 *
 * `StoryBodyParseError` already carries `field` (the section the parser was
 * reading) and `raw` (the entry text that failed); this lifts both into an
 * operator-legible message and a structured `violation` payload so an
 * authoring loop can point at the exact bullet instead of re-deriving it
 * from a downstream freshness miss.
 *
 * @param {object} story Story whose `body` is a non-empty markdown string.
 * @returns {object} The structured body.
 * @throws {ValidationError} `code: 'story-body-unparseable'`.
 */
export function parseStoryBodyOrThrow(story) {
  try {
    return parseStoryBody(story.body).body;
  } catch (err) {
    if (!(err instanceof StoryBodyParseError)) throw err;
    const slug = story.slug ?? '<unknown>';
    const section = err.field ?? 'body';
    const entry = err.raw ?? null;
    const entryLine = entry === null ? '' : `\n      entry: ${entry}`;
    const violation = { slug, section, entry, reason: err.message };
    const error = new ValidationError(
      `Cross-Validation Failed: Story "${slug}" has an unparseable body — ` +
        `the ## ${section} section could not be read: ${err.message}` +
        `${entryLine}\n\nFix the offending entry; this is a malformed body, ` +
        'not a stale path reference.',
      { violations: [violation] },
    );
    error.code = 'story-body-unparseable';
    error.violations = [violation];
    throw error;
  }
}

/**
 * Refuse the plan when any Story's serialized body cannot be parsed, before
 * either git-probe gate runs (Story #4541). Ordering matters: the freshness
 * gate consults `body.changes` for its net-new whitelist, so an unparseable
 * body used to reach the operator as a freshness miss naming declared paths.
 *
 * @param {{ tickets: object[] }} opts
 * @throws {ValidationError} `code: 'story-body-unparseable'` on the first
 *   offending Story.
 */
export function assertStoryBodiesParse({ tickets }) {
  for (const story of (tickets ?? []).filter((t) => t.type === 'story')) {
    if (typeof story.body !== 'string' || story.body.trim().length === 0) {
      continue;
    }
    parseStoryBodyOrThrow(story);
  }
}
