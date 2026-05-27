/**
 * tests/scripts/story-close-merge-subject.test.js — Story #2508 / Task #2522.
 *
 * Proves the subject-truncation helper shapes Conventional-Commits subjects
 * correctly *without* invoking git. Three fixtures pin the truncation
 * trigger boundary:
 *
 *   1. Short title  → no truncation, no warning, no body trailer.
 *   2. At-cap title → exactly at the cap, still no truncation.
 *   3. Over-cap title (120-char) → truncation fires:
 *        - assembled subject's byte length <= cap,
 *        - the `(resolves #N)` suffix is preserved verbatim,
 *        - Logger.warn fires exactly once,
 *        - a `truncated-from: <original>` body trailer is present.
 *
 * The child-process boundary is never touched: only the pure shape helper
 * and its wrapper are imported. If a regression accidentally wires
 * `child_process.spawnSync` into the shape path, this file will not catch
 * it — but neither will it `git commit`, so the test stays hermetic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  _resetHeaderMaxLengthCache,
  buildMergeMessageWithCap,
  shapeMergeSubject,
} from '../../.agents/scripts/lib/orchestration/story-close/merge-subject.js';

const COMMITLINT_DEFAULT_CAP = 100;

/**
 * Spy logger that records warn invocations. Tests assert call count and
 * the message content for the truncation event.
 */
function spyLogger() {
  const calls = [];
  return {
    calls,
    warn: (msg) => calls.push(msg),
  };
}

describe('story-close merge-subject — truncation boundary fixtures', () => {
  it('short-enough title → no truncation, no warn, no body trailer', () => {
    _resetHeaderMaxLengthCache();
    const logger = spyLogger();
    const title = 'short title that fits';
    const storyId = 42;

    const shaped = shapeMergeSubject({
      type: 'feat',
      title,
      storyId,
      headerMaxLength: COMMITLINT_DEFAULT_CAP,
      logger,
    });

    assert.equal(shaped.truncated, false);
    assert.equal(shaped.bodyTrailer, null);
    assert.equal(
      shaped.subject,
      `feat: short title that fits (resolves #${storyId})`,
    );
    assert.ok(
      Buffer.byteLength(shaped.subject, 'utf8') <= COMMITLINT_DEFAULT_CAP,
    );
    assert.equal(logger.calls.length, 0);
  });

  it('exactly-at-cap title → no truncation, no warn', () => {
    _resetHeaderMaxLengthCache();
    const logger = spyLogger();
    const storyId = 1;
    // Compose a title sized so the assembled subject is exactly 100 bytes:
    // prefix "feat: "             →  6
    // suffix " (resolves #1)"    → 14
    // → title budget = 100 - 6 - 14 = 80 bytes.
    const title = 'a'.repeat(80);

    const shaped = shapeMergeSubject({
      type: 'feat',
      title,
      storyId,
      headerMaxLength: COMMITLINT_DEFAULT_CAP,
      logger,
    });

    assert.equal(
      Buffer.byteLength(shaped.subject, 'utf8'),
      COMMITLINT_DEFAULT_CAP,
      'at-cap subject should be exactly 100 bytes',
    );
    assert.equal(shaped.truncated, false);
    assert.equal(shaped.bodyTrailer, null);
    assert.equal(logger.calls.length, 0);
  });

  it('over-cap (120-char title) → truncation fires, suffix preserved, warn once, body trailer present', () => {
    _resetHeaderMaxLengthCache();
    const logger = spyLogger();
    const storyId = 2466;
    // Twelve 10-char tokens separated by single spaces → 12*10 + 11 = 131 chars.
    // Truncation budget after `feat: ` (6) and ` (resolves #2466)` (17) = 77 bytes.
    const title = Array.from(
      { length: 12 },
      (_, i) => `token${String(i).padStart(2, '0')}xx`,
    ).join(' ');
    // Spirit of the Story's "120-char" fixture: assert the over-cap precondition explicitly.
    assert.ok(
      title.length >= 100,
      `title fixture must be at least 100 chars (got ${title.length})`,
    );
    const original = `feat: ${title.charAt(0).toLowerCase() + title.slice(1)} (resolves #${storyId})`;
    assert.ok(
      Buffer.byteLength(original, 'utf8') > COMMITLINT_DEFAULT_CAP,
      'fixture must exceed the cap before truncation',
    );

    const shaped = shapeMergeSubject({
      type: 'feat',
      title,
      storyId,
      headerMaxLength: COMMITLINT_DEFAULT_CAP,
      logger,
    });

    // (a) assembled subject is within the cap.
    assert.ok(
      Buffer.byteLength(shaped.subject, 'utf8') <= COMMITLINT_DEFAULT_CAP,
      `truncated subject (${Buffer.byteLength(shaped.subject, 'utf8')}) must fit cap`,
    );

    // (b) (resolves #N) suffix preserved verbatim.
    assert.ok(
      shaped.subject.endsWith(` (resolves #${storyId})`),
      `subject must end with (resolves #${storyId}): ${shaped.subject}`,
    );

    // (b.1) Conventional-Commits prefix preserved verbatim.
    assert.ok(shaped.subject.startsWith('feat: '));

    // (b.2) Truncation falls on a word boundary — no mid-token splits.
    const innerTitle = shaped.subject
      .slice('feat: '.length, -` (resolves #${storyId})`.length)
      .trim();
    for (const tok of innerTitle.split(/\s+/u)) {
      assert.ok(
        title.split(/\s+/u).includes(tok),
        `truncated token "${tok}" should be a full token from the original`,
      );
    }

    // (c) Logger.warn fired exactly once.
    assert.equal(
      logger.calls.length,
      1,
      'Logger.warn should fire exactly once per truncation event',
    );
    assert.match(logger.calls[0], /commitlint cap/i);
    assert.match(logger.calls[0], /word boundary/i);

    // (d) truncated-from body trailer present, references a prefix of the
    // original, AND fits within the cap so commitlint's
    // footer-max-line-length rule does not reject the auto-resolved
    // merge commit. When the original would overflow, the value portion is
    // truncated and an ellipsis is appended.
    assert.equal(shaped.truncated, true);
    assert.equal(typeof shaped.bodyTrailer, 'string');
    assert.match(shaped.bodyTrailer, /^truncated-from: /);
    assert.ok(
      Buffer.byteLength(shaped.bodyTrailer, 'utf8') <= COMMITLINT_DEFAULT_CAP,
      `trailer line (${Buffer.byteLength(shaped.bodyTrailer, 'utf8')}) must fit cap to satisfy footer-max-line-length`,
    );
    const trailerValue = shaped.bodyTrailer.slice('truncated-from: '.length);
    const trailerValueNoEllipsis = trailerValue.replace(/…$/u, '');
    assert.ok(
      shaped.original.startsWith(trailerValueNoEllipsis),
      'trailer value should be a prefix of the original subject',
    );
    // The original recorded by `shaped.original` is the over-cap one.
    assert.ok(
      Buffer.byteLength(shaped.original, 'utf8') > COMMITLINT_DEFAULT_CAP,
    );
  });
});

describe('story-close merge-subject — buildMergeMessageWithCap wrapper', () => {
  it('returns subject-only message when no truncation is needed', () => {
    _resetHeaderMaxLengthCache();
    const out = buildMergeMessageWithCap({
      type: 'feat',
      title: 'short title',
      storyId: 9,
      headerMaxLength: COMMITLINT_DEFAULT_CAP,
      logger: spyLogger(),
    });
    assert.equal(out.truncated, false);
    assert.equal(out.message, 'feat: short title (resolves #9)');
    assert.ok(!out.message.includes('\n'));
  });

  it('appends the truncated-from trailer to the commit message when truncation fires', () => {
    _resetHeaderMaxLengthCache();
    const logger = spyLogger();
    const title = 'an extremely long story title '.repeat(5).trim();
    const out = buildMergeMessageWithCap({
      type: 'feat',
      title,
      storyId: 7,
      headerMaxLength: COMMITLINT_DEFAULT_CAP,
      logger,
    });
    assert.equal(out.truncated, true);
    assert.ok(out.message.includes('\n\ntruncated-from: '));
    // The subject (first line) is within the cap.
    const subject = out.message.split('\n', 1)[0];
    assert.ok(Buffer.byteLength(subject, 'utf8') <= COMMITLINT_DEFAULT_CAP);
    // Every line of the message — including the trailer — fits within the
    // cap so commitlint's footer-max-line-length rule does not reject the
    // auto-resolved merge commit.
    for (const line of out.message.split('\n')) {
      assert.ok(
        Buffer.byteLength(line, 'utf8') <= COMMITLINT_DEFAULT_CAP,
        `line "${line}" (${Buffer.byteLength(line, 'utf8')}) must fit cap`,
      );
    }
    // Trailer value is a prefix of the original (possibly with ellipsis).
    const trailerLine = out.message
      .split('\n')
      .find((l) => l.startsWith('truncated-from: '));
    const trailerValue = trailerLine.slice('truncated-from: '.length);
    const trailerValueNoEllipsis = trailerValue.replace(/…$/u, '');
    assert.ok(out.original.startsWith(trailerValueNoEllipsis));
    assert.equal(logger.calls.length, 1);
  });
});
