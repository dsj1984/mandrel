/**
 * planning-corpus.test.js — covers the standalone-Story corpus context
 * (Story #4432).
 *
 *   - buildCorpusContext: the docs-digest passthrough, plus the pinned
 *     empty `relevantSections` field. The Epic-ranking pipeline that
 *     once populated that field was removed with the Epic tier — the
 *     provider's Epic-list surface had been reduced to a `return []`
 *     stub, making the pipeline a permanent no-op.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildCorpusContext } from '../.agents/scripts/lib/planning-corpus.js';

describe('buildCorpusContext', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'planning-corpus-'));
    mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns docsDigest: null when no docsContextFiles are configured', async () => {
    const ctx = await buildCorpusContext({
      docsContextFiles: [],
      docsRoot: path.join(tmp, 'docs'),
    });
    assert.equal(ctx.docsDigest, null);
    assert.deepEqual(ctx.relevantSections, []);
  });

  it('builds a non-null docsDigest when docsContextFiles resolve', async () => {
    writeFileSync(
      path.join(tmp, 'docs', 'architecture.md'),
      '# Architecture\n\n## Overview\n\nSome architecture notes.\n',
    );
    const ctx = await buildCorpusContext({
      docsContextFiles: ['architecture.md'],
      docsRoot: path.join(tmp, 'docs'),
    });
    assert.equal(typeof ctx.docsDigest, 'string');
    assert.match(ctx.docsDigest, /architecture\.md/);
  });

  it('pins relevantSections to [] — the Epic-ranking pipeline is gone', async () => {
    const ctx = await buildCorpusContext({
      docsContextFiles: [],
      docsRoot: path.join(tmp, 'docs'),
    });
    assert.deepEqual(ctx.relevantSections, []);
  });
});
