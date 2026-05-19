import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildDocsContext,
  scrapeProjectDocs,
} from '../../.agents/scripts/lib/orchestration/doc-reader.js';

describe('doc-reader.scrapeProjectDocs', () => {
  let tmpDocsDir;

  beforeEach(() => {
    tmpDocsDir = path.join(os.tmpdir(), `mandrel-docs-${Date.now()}`);
    fs.mkdirSync(tmpDocsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDocsDir)) {
      fs.rmSync(tmpDocsDir, { recursive: true, force: true });
    }
  });

  it('returns raw doc objects for all .md files by default', async () => {
    fs.writeFileSync(path.join(tmpDocsDir, 'doc1.md'), 'Content 1');
    fs.writeFileSync(path.join(tmpDocsDir, 'doc2.md'), 'Content 2');
    fs.writeFileSync(path.join(tmpDocsDir, 'not-a-doc.txt'), 'Text');

    const out = await scrapeProjectDocs({ project: { paths: { docsRoot: tmpDocsDir } } });

    assert.equal(out.usedFallback, true);
    const names = out.docs.map((d) => d.name).sort();
    assert.deepEqual(names, ['doc1.md', 'doc2.md']);
    const doc1 = out.docs.find((d) => d.name === 'doc1.md');
    assert.equal(doc1.content, 'Content 1');
  });

  it('filters by docsContextFiles when provided and clears the fallback flag', async () => {
    fs.writeFileSync(path.join(tmpDocsDir, 'doc1.md'), 'Content 1');
    fs.writeFileSync(path.join(tmpDocsDir, 'doc2.md'), 'Content 2');

    const out = await scrapeProjectDocs({
      paths: { docsRoot: tmpDocsDir },
      docsContextFiles: ['doc2.md'],
    });

    assert.equal(out.usedFallback, false);
    assert.equal(out.docs.length, 1);
    assert.equal(out.docs[0].name, 'doc2.md');
    assert.equal(out.docs[0].content, 'Content 2');
  });

  it('returns an empty docs list if docsRoot does not exist', async () => {
    const out = await scrapeProjectDocs({
      paths: { docsRoot: '/non/existent/path' },
    });
    assert.deepEqual(out, { docs: [], usedFallback: false });
  });

  it('returns an empty docs list when the directory is empty', async () => {
    const out = await scrapeProjectDocs({ project: { paths: { docsRoot: tmpDocsDir } } });
    assert.equal(out.docs.length, 0);
  });
});

describe('doc-reader.buildDocsContext', () => {
  let tmpDocsDir;

  beforeEach(() => {
    tmpDocsDir = path.join(os.tmpdir(), `mandrel-docs-${Date.now()}`);
    fs.mkdirSync(tmpDocsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDocsDir)) {
      fs.rmSync(tmpDocsDir, { recursive: true, force: true });
    }
  });

  it('returns full mode for small payloads under the budget', async () => {
    fs.writeFileSync(path.join(tmpDocsDir, 'a.md'), 'small');
    const out = await buildDocsContext(
      { project: { paths: { docsRoot: tmpDocsDir } }, docsContextFiles: ['a.md'] },
      { maxBytes: 50000, summaryMode: 'auto' },
    );
    assert.equal(out.mode, 'full');
    assert.equal(out.items[0].content, 'small');
    assert.equal(out.usedFallback, false);
  });

  it('downgrades to summary mode when payload exceeds maxBytes', async () => {
    const big = `## Heading\n\n${'x'.repeat(2000)}\n`;
    fs.writeFileSync(path.join(tmpDocsDir, 'big.md'), big);
    const out = await buildDocsContext(
      { project: { paths: { docsRoot: tmpDocsDir } }, docsContextFiles: ['big.md'] },
      { maxBytes: 500, summaryMode: 'auto' },
    );
    assert.equal(out.mode, 'summary');
    assert.deepEqual(out.items[0].headings, ['Heading']);
  });

  it('honours fullContext opt to restore original bodies', async () => {
    const big = `## Heading\n\n${'x'.repeat(2000)}\n`;
    fs.writeFileSync(path.join(tmpDocsDir, 'big.md'), big);
    const out = await buildDocsContext(
      { project: { paths: { docsRoot: tmpDocsDir } }, docsContextFiles: ['big.md'] },
      { maxBytes: 500, summaryMode: 'auto' },
      { fullContext: true },
    );
    assert.equal(out.mode, 'full');
    assert.equal(out.items[0].content, big);
  });

  it('propagates usedFallback when docsContextFiles is unset', async () => {
    fs.writeFileSync(path.join(tmpDocsDir, 'a.md'), 'small');
    const out = await buildDocsContext({ project: { paths: { docsRoot: tmpDocsDir } } });
    assert.equal(out.usedFallback, true);
  });
});
