/**
 * tests/agents/story-worker-ladder.test.js — the worker's
 * smallest-complete-change ladder (Story #5762).
 *
 * The quality ratchets bite after code exists; this section is the brake
 * before it is written. Pins stay loose — heading placement, rung order by
 * keyword, the `shortcut:` comment form, the never-cut terms — so a rewrite
 * that says the same thing in fewer bytes stays green.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertDocMentions } from '../helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents/agents/story-worker.md',
);
const HEADING = '## Smallest complete change (MUST)';

const src = readFileSync(WORKER, 'utf8');

function ladderSection() {
  const start = src.indexOf(HEADING);
  assert.notEqual(start, -1, `story-worker.md has no "${HEADING}" section`);
  const rest = src.slice(start + HEADING.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('story-worker smallest-complete-change ladder', () => {
  it('sits in the role delta, before Commit discipline', () => {
    const marker = src.indexOf('<!-- role-delta:');
    const heading = src.indexOf(HEADING);
    assert.ok(marker !== -1 && heading > marker, 'section is above the marker');
    assert.ok(heading < src.indexOf('## Commit discipline'));
  });

  it('lists the six rungs as a numbered list, in order', () => {
    const items = ladderSection()
      .split('\n')
      .filter((line) => /^\d+\.\s/.test(line));
    const rungs = [
      /exist/i,
      /codebase/i,
      /standard library/i,
      /dependency/i,
      /one line/i,
      /minimum/i,
    ];
    assert.equal(items.length, rungs.length, 'six numbered rungs');
    for (const [i, rung] of rungs.entries()) assert.match(items[i], rung);
  });

  it('carries the shortcut comment form exactly once', () => {
    assert.equal(ladderSection().split('shortcut: <').length - 1, 1);
  });

  it('names the finish-every-caller rule and the never-cut list', () => {
    const section = ladderSection();
    // assertDocMentions collapses whitespace runs (newlines included) before
    // matching, so a phrase wrapped across lines still matches a plain space.
    assertDocMentions(section, /finish every caller/i);
    assertDocMentions(section, /never cut.*trust-boundary validation/i);
    assertDocMentions(section, /data loss/i);
    assertDocMentions(section, /security/i);
    assertDocMentions(section, /accessibility/i);
    assertDocMentions(section, /acceptance/i);
  });
});
