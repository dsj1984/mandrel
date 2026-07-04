/**
 * Unit tests for the per-Epic docs digest builder (Story #4338).
 *
 * `buildDocsDigest` reads the configured `docsContextFiles` from `docsRoot`
 * and emits one compact markdown outline per file (path, byte size, heading
 * outline with line numbers, first paragraph under each `##`). Missing files
 * are skipped silently; an empty/unset file list yields `null` (the no-op
 * path this repo's config exercises, since its `.agentrc.json` sets no
 * `docsContextFiles`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { buildDocsDigest } from '../../.agents/scripts/lib/orchestration/docs-digest.js';

let docsRoot;

beforeEach(() => {
  docsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-digest-'));
});

afterEach(() => {
  fs.rmSync(docsRoot, { recursive: true, force: true });
});

function writeDoc(name, content) {
  fs.writeFileSync(path.join(docsRoot, name), content, 'utf-8');
}

test('returns null when docsContextFiles is unset', async () => {
  const digest = await buildDocsDigest({ docsRoot });
  assert.equal(digest, null);
});

test('returns null when docsContextFiles is empty', async () => {
  const digest = await buildDocsDigest({ docsContextFiles: [], docsRoot });
  assert.equal(digest, null);
});

test('returns null when every configured file is missing', async () => {
  const digest = await buildDocsDigest({
    docsContextFiles: ['absent.md', 'also-gone.md'],
    docsRoot,
  });
  assert.equal(digest, null);
});

test('emits path, byte size, heading outline with line numbers, and first paragraph', async () => {
  const body = [
    '# Architecture', // line 1 (H1 ignored by outline granularity)
    '',
    '## Overview', // line 3
    '',
    'The system is layered.', // first paragraph under Overview
    'Second line of the same paragraph.',
    '',
    'A later paragraph that must NOT appear.',
    '',
    '### Sub-detail', // line 10
    '',
    'Sub prose (not captured — only H2 gets a paragraph).',
    '',
    '## Data flow', // line 14
    '',
    'Requests flow inbound.', // first paragraph under Data flow
  ].join('\n');
  writeDoc('architecture.md', body);

  const digest = await buildDocsDigest({
    docsContextFiles: ['architecture.md'],
    docsRoot,
  });

  assert.ok(digest, 'digest should be non-null');
  // Relative path (not absolute) is used as the section key.
  assert.match(digest, /### `architecture\.md`/);
  assert.doesNotMatch(digest, new RegExp(docsRoot.replace(/[/\\]/g, '.')));
  // Byte size surfaced.
  assert.match(
    digest,
    new RegExp(`\\(${Buffer.byteLength(body, 'utf-8')} bytes\\)`),
  );
  // Heading outline with line numbers for the H2/H3 headings.
  assert.match(digest, /L3 `##` Overview/);
  assert.match(digest, /L10 `###` Sub-detail/);
  assert.match(digest, /L14 `##` Data flow/);
  // First paragraph under each H2 (joined across wrapped lines).
  assert.match(
    digest,
    /The system is layered\. Second line of the same paragraph\./,
  );
  assert.match(digest, /Requests flow inbound\./);
  // A later paragraph under the same heading is excluded.
  assert.doesNotMatch(digest, /must NOT appear/);
});

test('skips missing files but digests the present ones', async () => {
  writeDoc('present.md', '## Section\n\nBody text.');

  const digest = await buildDocsDigest({
    docsContextFiles: ['missing.md', 'present.md'],
    docsRoot,
  });

  assert.ok(digest);
  assert.match(digest, /### `present\.md`/);
  assert.doesNotMatch(digest, /missing\.md/);
});

test('preserves the configured file order in the digest', async () => {
  writeDoc('alpha.md', '## Alpha\n\nA.');
  writeDoc('beta.md', '## Beta\n\nB.');

  const digest = await buildDocsDigest({
    docsContextFiles: ['beta.md', 'alpha.md'],
    docsRoot,
  });

  assert.ok(digest);
  const betaIdx = digest.indexOf('`beta.md`');
  const alphaIdx = digest.indexOf('`alpha.md`');
  assert.ok(betaIdx >= 0 && alphaIdx >= 0);
  assert.ok(betaIdx < alphaIdx, 'beta.md should appear before alpha.md');
});

test('handles a doc with no ## / ### headings', async () => {
  writeDoc('flat.md', 'Just a paragraph, no headings at all.\n');

  const digest = await buildDocsDigest({
    docsContextFiles: ['flat.md'],
    docsRoot,
  });

  assert.ok(digest);
  assert.match(digest, /### `flat\.md`/);
  assert.match(digest, /No `##`\/`###` headings/);
});
