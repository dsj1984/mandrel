/**
 * The one place a Story body is parsed with failures translated into a
 * `ValidationError` naming the section and entry.
 */

import { ValidationError } from '../errors/index.js';
import {
  parse as parseStoryBody,
  StoryBodyParseError,
} from '../story-body/story-body.js';

/**
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
 * Must run before the git-probe gates, whose whitelist is the parsed body.
 *
 * @param {{ tickets: object[] }} opts
 * @throws {ValidationError} On the first offending Story.
 */
export function assertStoryBodiesParse({ tickets }) {
  for (const story of (tickets ?? []).filter((t) => t.type === 'story')) {
    if (typeof story.body !== 'string' || story.body.trim().length === 0) {
      continue;
    }
    parseStoryBodyOrThrow(story);
  }
}
