import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  extractManifestJson,
  renderManifestFromComment,
  writeRenderedManifest,
} from '../.agents/scripts/render-manifest.js';

test('extractManifestJson parses a fenced JSON block', () => {
  const body = [
    '## 📋 Dispatch Manifest — Epic #42',
    '',
    'stuff',
    '',
    '```json',
    JSON.stringify({ stories: [{ storyId: 1, wave: 0, title: 'A' }] }),
    '```',
  ].join('\n');
  const parsed = extractManifestJson(body);
  assert.deepStrictEqual(parsed, {
    stories: [{ storyId: 1, wave: 0, title: 'A' }],
  });
});

test('extractManifestJson returns null when no JSON block present', () => {
  assert.strictEqual(extractManifestJson('no json here'), null);
  assert.strictEqual(extractManifestJson(''), null);
  assert.strictEqual(extractManifestJson(undefined), null);
});

test('extractManifestJson returns null when JSON block is malformed', () => {
  const body = '```json\nnot valid {\n```';
  assert.strictEqual(extractManifestJson(body), null);
});

test('writeRenderedManifest produces md + json under temp/', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-render-'));
  try {
    const body = '## Dispatch Manifest — Epic #7\n\nbody\n';
    const parsed = { stories: [{ storyId: 5, wave: 0, title: 'x' }] };
    const { mdPath, jsonPath } = writeRenderedManifest({
      epicId: 7,
      body,
      parsed,
      projectRoot: tmp,
    });
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), body);
    const jsonOnDisk = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepStrictEqual(jsonOnDisk, parsed);
    // Per-Epic layout (Epic #1030 Story #1040): the renderer now writes
    // under `temp/epic-<eid>/manifest.{md,json}`.
    assert.ok(
      mdPath.replaceAll('\\', '/').endsWith('temp/epic-7/manifest.md'),
      `unexpected md path: ${mdPath}`,
    );
    assert.ok(
      jsonPath.replaceAll('\\', '/').endsWith('temp/epic-7/manifest.json'),
      `unexpected json path: ${jsonPath}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderManifestFromComment exits 1 when no manifest comment exists', async () => {
  const provider = {
    getTicketComments: async () => [],
  };
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`__exit:${code}`);
  };
  try {
    await assert.rejects(
      renderManifestFromComment({ epicId: 7, injectedProvider: provider }),
      /__exit:1/,
    );
    assert.strictEqual(exitCode, 1);
  } finally {
    process.exit = origExit;
  }
});

test('renderManifestFromComment exits 1 when body has no JSON block', async () => {
  const provider = {
    getTicketComments: async () => [
      {
        id: 99,
        body: '<!-- ap:structured-comment type="dispatch-manifest" -->\n\njust prose',
      },
    ],
  };
  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => {
    exitCode = code;
    throw new Error(`__exit:${code}`);
  };
  try {
    await assert.rejects(
      renderManifestFromComment({ epicId: 7, injectedProvider: provider }),
      /__exit:1/,
    );
    assert.strictEqual(exitCode, 1);
  } finally {
    process.exit = origExit;
  }
});
