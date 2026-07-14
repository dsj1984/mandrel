/**
 * tests/plan-docs-digest.test.js — Story #4433
 *
 * Digest-first planning reads: the epic-path planner context
 * (`epic-plan-spec.js --emit-context` → `buildAuthoringContext`) ensures a
 * per-Epic docs digest and emits a digest-first `docsContext` envelope field
 * — `{ mode: 'digest', digestPath }` — instead of embedding full/summarized
 * doc content. This mirrors the Story #4324 delivery-children cutover and
 * reuses the very same shared generator (`ensureDocsDigest` in
 * `docs-digest.js`) and file convention
 * (`<tempRoot>/epic-<epicId>/docs-digest.md`) the `/deliver` story
 * sub-agents already consume.
 *
 * Three things are asserted here:
 *   1. `ensureDocsDigest` (the shared generate-and-write export) writes the
 *      digest to an arbitrary `outputPath` and no-ops (no write) when there
 *      is nothing to digest.
 *   2. `buildAuthoringContext`'s `docsContext` field is digest-first when
 *      `project.docsContextFiles` is configured: a digest file lands at the
 *      per-Epic temp path and the envelope points at it.
 *   3. `buildAuthoringContext`'s `docsContext` field degrades to a silent
 *      no-op (`null`, no file written) when `docsContextFiles` is unset —
 *      the hard-cutover contract has no read-everything fallback branch.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ensureDocsDigest } from '../.agents/scripts/lib/orchestration/docs-digest.js';
import { buildAuthoringContext } from '../.agents/scripts/lib/orchestration/planning/authoring-context.js';

function stubProvider(body = '## Scope\n\nSome epic body.') {
  return {
    async getEpic(id) {
      return {
        id,
        title: 'Digest-first planning reads',
        body,
        labels: ['type::epic'],
      };
    },
  };
}

describe('docs-digest.ensureDocsDigest — shared generate-and-write export (Story #4433)', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-docs-digest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes the digest to outputPath, creating parent directories', async () => {
    const docsRoot = path.join(tmpRoot, 'docs');
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(docsRoot, 'architecture.md'),
      '## Overview\n\nThe system is layered.\n',
      'utf-8',
    );

    const outputPath = path.join(
      tmpRoot,
      'temp',
      'epic-4433',
      'docs-digest.md',
    );
    const result = await ensureDocsDigest({
      docsContextFiles: ['architecture.md'],
      docsRoot,
      outputPath,
    });

    assert.ok(result, 'ensureDocsDigest should report a written digest');
    assert.equal(result.outputPath, outputPath);
    assert.ok(fs.existsSync(outputPath), 'digest file should be written');
    const written = fs.readFileSync(outputPath, 'utf-8');
    assert.equal(written, result.digest);
    assert.match(written, /### `architecture\.md`/);
    assert.match(written, /The system is layered\./);
  });

  it('returns null and writes nothing when there is no docsContextFiles configured', async () => {
    const outputPath = path.join(
      tmpRoot,
      'temp',
      'epic-4433',
      'docs-digest.md',
    );

    const result = await ensureDocsDigest({
      docsContextFiles: [],
      docsRoot: path.join(tmpRoot, 'docs'),
      outputPath,
    });

    assert.equal(result, null);
    assert.equal(
      fs.existsSync(outputPath),
      false,
      'no file should be written when there is nothing to digest',
    );
    assert.equal(
      fs.existsSync(path.dirname(outputPath)),
      false,
      'the parent directory should not be created either',
    );
  });

  it('returns null when every configured file is missing (nothing to digest)', async () => {
    const docsRoot = path.join(tmpRoot, 'docs');
    fs.mkdirSync(docsRoot, { recursive: true });
    const outputPath = path.join(
      tmpRoot,
      'temp',
      'epic-4433',
      'docs-digest.md',
    );

    const result = await ensureDocsDigest({
      docsContextFiles: ['absent.md'],
      docsRoot,
      outputPath,
    });

    assert.equal(result, null);
    assert.equal(fs.existsSync(outputPath), false);
  });
});

describe('buildAuthoringContext — digest-first docsContext (Story #4433)', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-docs-digest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('ensures a per-Epic docs digest and points docsContext at it when docsContextFiles is configured', async () => {
    const docsRoot = path.join(tmpRoot, 'docs');
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(docsRoot, 'architecture.md'),
      '## Overview\n\nRequests flow inbound.\n',
      'utf-8',
    );

    const settings = {
      paths: { docsRoot: 'docs', tempRoot: 'temp' },
      docsContextFiles: ['architecture.md'],
    };

    const ctx = await buildAuthoringContext(4433, stubProvider(), settings, {
      cwd: tmpRoot,
    });

    assert.ok(ctx.docsContext, 'docsContext must be present when configured');
    assert.equal(ctx.docsContext.mode, 'digest');
    // No embedded doc content on the envelope — digest-first only.
    assert.equal('items' in ctx.docsContext, false);

    const expectedRelPath = path.join('temp', 'epic-4433', 'docs-digest.md');
    assert.equal(ctx.docsContext.digestPath, expectedRelPath);

    const absDigestPath = path.join(tmpRoot, expectedRelPath);
    assert.ok(
      fs.existsSync(absDigestPath),
      'the digest file must be written at the per-Epic temp path',
    );
    const digestBody = fs.readFileSync(absDigestPath, 'utf-8');
    assert.match(digestBody, /### `architecture\.md`/);
    assert.match(digestBody, /Requests flow inbound\./);
  });

  it('degrades to a silent no-op when docsContextFiles is not configured', async () => {
    const ctx = await buildAuthoringContext(
      4434,
      stubProvider(),
      {},
      {
        cwd: tmpRoot,
      },
    );

    assert.equal(
      ctx.docsContext,
      null,
      'docsContext must be a silent no-op with no docsContextFiles configured',
    );
    assert.equal(
      fs.existsSync(path.join(tmpRoot, 'temp')),
      false,
      'no digest file (or temp dir) should be written when there is nothing to digest',
    );
  });

  it('reuses the same per-Epic file the /deliver story sub-agents consume', async () => {
    // This is the same relative-path convention epic-deliver-prepare.js
    // uses for the delivery-children digest
    // (`<tempRoot>/epic-<epicId>/docs-digest.md`) — planning and delivery
    // share one file per Epic, generated by the same `ensureDocsDigest`
    // export, rather than each surface owning its own generator/path.
    const docsRoot = path.join(tmpRoot, 'docs');
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(docsRoot, 'decisions.md'),
      '## D1\n\nUse digests.\n',
      'utf-8',
    );

    const settings = {
      paths: { docsRoot: 'docs', tempRoot: 'temp' },
      docsContextFiles: ['decisions.md'],
    };

    const ctx = await buildAuthoringContext(4444, stubProvider(), settings, {
      cwd: tmpRoot,
    });

    assert.equal(
      ctx.docsContext.digestPath,
      path.join('temp', 'epic-4444', 'docs-digest.md'),
    );
  });
});
