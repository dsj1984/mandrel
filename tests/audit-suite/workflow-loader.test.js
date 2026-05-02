import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultWriteArtifact,
  loadWorkflow,
} from '../../.agents/scripts/lib/audit-suite/workflow-loader.js';

async function withTmp(prefix, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loadWorkflow: returns null when workflow file is missing', async () => {
  await withTmp('audit-loader', async (dir) => {
    const out = await loadWorkflow('does-not-exist', dir);
    assert.equal(out, null);
  });
});

test('loadWorkflow: returns { path, content } when the file exists', async () => {
  await withTmp('audit-loader', async (dir) => {
    const file = path.join(dir, 'audit-x.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '# audit-x body', 'utf8');

    const out = await loadWorkflow('audit-x', dir);
    assert.ok(out);
    assert.equal(out.path, file);
    assert.equal(out.content, '# audit-x body');
  });
});

test('defaultWriteArtifact: creates the artifact dir on demand and writes the file', async () => {
  await withTmp('audit-writer', async (dir) => {
    const artifactsDir = path.join(dir, 'nested', 'artifacts');
    const fullPath = await defaultWriteArtifact(
      artifactsDir,
      'audit-foo.md',
      'hello',
    );
    assert.equal(fullPath, path.join(artifactsDir, 'audit-foo.md'));
    const back = await readFile(fullPath, 'utf8');
    assert.equal(back, 'hello');
  });
});
