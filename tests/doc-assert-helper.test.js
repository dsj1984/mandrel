/**
 * tests/doc-assert-helper.test.js — the line-wrap-independent doc assertions.
 *
 * The helper exists to remove a defect class from the workflow-doc suite, so
 * the tests that matter are the two the old `assert.match` got wrong:
 *
 *   1. a **positive** claim about prose fails when the phrase re-wraps, even
 *      though the document still says it — a false red on a correct edit;
 *   2. a **negative** guard against a forbidden phrase passes when the phrase
 *      re-wraps — a false green, which is the dangerous direction.
 *
 * Both are pinned below against `assert.match` / `assert.doesNotMatch`
 * behaviour, so this file also documents *why* the plain assertions were
 * replaced rather than merely that they were.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertDocMentions,
  assertDocOmits,
  normalizeProse,
} from './helpers/doc-assert.js';

/** A doc hard-wrapped exactly where the phrase under test straddles a line. */
const WRAPPED = [
  'Ceremony depth (profiles + derived level via `ceremony-routing.js`, review',
  'depth reading the same level) and the mechanism table follow.',
  '',
  'Never reintroduce the `git merge --no-ff` wave merge: dependent Stories land',
  'sequentially instead.',
].join('\n');

describe('normalizeProse', () => {
  it('collapses every whitespace run — newlines included — to one space', () => {
    assert.equal(
      normalizeProse('a\n  b\t\tc\r\n\r\nd'),
      'a b c d',
      'a pattern written as one sentence must see one sentence',
    );
  });

  it('is null-safe and trims the ends', () => {
    assert.equal(normalizeProse('  padded\n'), 'padded');
    assert.equal(normalizeProse(undefined), '');
    assert.equal(normalizeProse(null), '');
  });
});

describe('assertDocMentions — the false red it removes', () => {
  it('matches a phrase that markdown wrapped across two lines', () => {
    // The exact failure this helper was written for: the doc says "review
    // depth", the wrap puts a newline in the middle, and the literal space in
    // the pattern stops matching.
    assert.throws(
      () => assert.match(WRAPPED, /derived level.*review depth/i),
      /AssertionError/,
      'baseline: plain assert.match is the thing that goes red here',
    );
    assert.doesNotThrow(() =>
      assertDocMentions(
        WRAPPED,
        /derived level.*review depth/i,
        'the doc must document the derived-level ceremony',
      ),
    );
  });

  it('still fails when the document genuinely does not say it', () => {
    assert.throws(
      () =>
        assertDocMentions(
          WRAPPED,
          /planner-authored risk verdict/i,
          'the doc must name the risk verdict',
        ),
      (err) =>
        err.message.includes('the doc must name the risk verdict') &&
        err.message.includes('expected to find') &&
        // The whole document must NOT be dumped into the failure output.
        !err.message.includes('mechanism table'),
      'a real content gap must still fail, with a short message',
    );
  });
});

describe('assertDocOmits — the false green it removes', () => {
  it('catches a forbidden phrase that hid by straddling a line break', () => {
    const straddled = 'Dependent Stories use a git merge\n--no-ff wave merge.';
    assert.doesNotThrow(
      () => assert.doesNotMatch(straddled, /git merge --no-ff/),
      'baseline: plain assert.doesNotMatch passes — the guard silently misses',
    );
    assert.throws(
      () =>
        assertDocOmits(
          straddled,
          /git merge --no-ff/,
          'the v2 engine has no --no-ff wave merge',
        ),
      /has no --no-ff wave merge/,
      'the normalized guard must catch what the wrap hid',
    );
  });

  it('passes when the phrase is genuinely absent, and quotes the hit when not', () => {
    assert.doesNotThrow(() =>
      assertDocOmits(WRAPPED, /resolveAuditLenses/, 'router was deleted'),
    );
    assert.throws(
      () => assertDocOmits(WRAPPED, /wave merge/, 'no wave merge'),
      /matched: "wave merge"/,
      'a negative failure must show what it found',
    );
  });
});
