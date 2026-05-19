/**
 * tests/lib/feedback-loop/memory-freshness.test.js — Story #2557 / Task #2569
 *
 * Unit tests for `scanMemoryFreshness`. All filesystem and gh-CLI access is
 * routed through injected seams so no real network or disk mutation occurs
 * outside the test's tmp directory.
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { scanMemoryFreshness } from '../../../.agents/scripts/lib/feedback-loop/memory-freshness.js';

function makeTmpDir(label) {
  return mkdtempSync(path.join(os.tmpdir(), `memfresh-${label}-`));
}

describe('scanMemoryFreshness', () => {
  let memoryDir;
  let projectRoot;

  before(async () => {
    projectRoot = makeTmpDir('proj');
    memoryDir = makeTmpDir('mem');
    // Seed a real file inside projectRoot so live-reference checks pass.
    await fs.writeFile(
      path.join(projectRoot, 'live-file.md'),
      '# live\n',
      'utf8',
    );
  });

  after(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  it('returns a graceful error envelope when the memory directory is missing', async () => {
    const result = await scanMemoryFreshness({
      memoryDir: path.join(os.tmpdir(), `does-not-exist-${Date.now()}`),
      ghPath: '',
      projectRoot,
    });
    assert.equal(result.scanned, 0);
    assert.equal(result.staleEntries.length, 0);
    assert.ok(result.errors.length >= 1);
    assert.equal(result.errors[0].phase, 'discover');
  });

  it('does not throw when memoryDir argument is missing', async () => {
    const result = await scanMemoryFreshness({ ghPath: '' });
    assert.equal(result.scanned, 0);
    assert.equal(result.errors[0].phase, 'discover');
  });

  it('passes through entries whose file references all exist', async () => {
    const fresh = path.join(memoryDir, 'fresh-entry.md');
    await fs.writeFile(
      fresh,
      '---\ntitle: fresh\n---\nReferences live-file.md only.\n',
      'utf8',
    );

    const result = await scanMemoryFreshness({
      memoryDir,
      ghPath: '',
      projectRoot,
    });
    assert.equal(result.scanned >= 1, true);
    const stale = result.staleEntries.find((e) => e.file === 'fresh-entry.md');
    assert.equal(stale, undefined, 'fresh entry must not be flagged stale');

    // Frontmatter must remain unmodified.
    const after = await fs.readFile(fresh, 'utf8');
    assert.ok(!/stale:\s*true/.test(after));
  });

  it('flags entries whose file reference no longer exists', async () => {
    const dead = path.join(memoryDir, 'dead-file-entry.md');
    await fs.writeFile(
      dead,
      '---\ntitle: dead-file\n---\nLinks to deleted-target.js which is gone.\n',
      'utf8',
    );

    const result = await scanMemoryFreshness({
      memoryDir,
      ghPath: '',
      projectRoot,
    });
    const stale = result.staleEntries.find(
      (e) => e.file === 'dead-file-entry.md',
    );
    assert.ok(stale, 'dead-file entry must be flagged stale');
    assert.match(stale.reason, /deleted-target\.js/);

    const after = await fs.readFile(dead, 'utf8');
    assert.match(after, /stale:\s*true/);
    assert.match(after, /staleReason:/);
    assert.match(after, /staleDetectedAt:/);
    // Body preserved verbatim.
    assert.match(after, /Links to deleted-target\.js which is gone\./);
  });

  it('flags entries whose referenced GitHub issue is closed', async () => {
    const closed = path.join(memoryDir, 'closed-issue-entry.md');
    await fs.writeFile(
      closed,
      '---\ntitle: closed-issue\n---\nSee #4242 for prior context.\n',
      'utf8',
    );

    // Stub spawn: probe `gh issue view 4242 --json state` returns "closed".
    const spawnImpl = (_cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        if (args.includes('issue') && args.includes('view')) {
          child.stdout.emit('data', Buffer.from('{"state":"CLOSED"}'));
          child.emit('close', 0);
          return;
        }
        child.emit('close', 0);
      });
      return child;
    };

    const result = await scanMemoryFreshness({
      memoryDir,
      ghPath: 'gh',
      spawnImpl,
      projectRoot,
    });
    const stale = result.staleEntries.find(
      (e) => e.file === 'closed-issue-entry.md',
    );
    assert.ok(stale, 'closed-issue entry must be flagged stale');
    assert.match(stale.reason, /#4242/);
  });

  it('is idempotent — stale entries are not re-flagged or re-written', async () => {
    const dir = makeTmpDir('idem');
    try {
      const file = path.join(dir, 'already-stale.md');
      const body = [
        '---',
        'title: already-stale',
        'stale: true',
        'staleReason: prior run',
        'staleDetectedAt: 2026-05-01T00:00:00.000Z',
        '---',
        'Originally referenced gone.js.',
        '',
      ].join('\n');
      await fs.writeFile(file, body, 'utf8');
      const mtimeBefore = (await fs.stat(file)).mtimeMs;

      const result = await scanMemoryFreshness({
        memoryDir: dir,
        ghPath: '',
        projectRoot,
      });
      const flagged = result.staleEntries.find(
        (e) => e.file === 'already-stale.md',
      );
      assert.equal(flagged, undefined, 'already-stale entry must be skipped');

      const after = await fs.readFile(file, 'utf8');
      assert.equal(after, body, 'file body must be untouched');
      const mtimeAfter = (await fs.stat(file)).mtimeMs;
      assert.equal(
        mtimeAfter,
        mtimeBefore,
        'mtime must not advance on idempotent re-run',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never throws on individual file read failures (errors[] captures them)', async () => {
    // Inject an fsImpl whose readdir succeeds but readFile rejects.
    const fsImpl = {
      readdir: async () => ['poison.md'],
      readFile: async () => {
        throw new Error('EACCES poison');
      },
      writeFile: async () => {},
      rename: async () => {},
      access: async () => {},
    };
    const result = await scanMemoryFreshness({
      memoryDir: '/fake',
      fsImpl,
      ghPath: '',
      projectRoot,
    });
    assert.equal(result.staleEntries.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].phase, 'read');
    assert.match(result.errors[0].reason, /EACCES poison/);
  });
});
