import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { scaffoldDocs } from '../../.agents/scripts/lib/onboard/scaffold-docs.js';

/** Create an isolated temp project root with an optional .agentrc.json. */
function makeProject(agentrc) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-docs-'));
  if (agentrc !== undefined) {
    fs.writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify(agentrc, null, 2),
      'utf8',
    );
  }
  return root;
}

let roots;
beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function track(root) {
  roots.push(root);
  return root;
}

test('reports which configured docsContextFiles are absent under the docs root', () => {
  const root = track(
    makeProject({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles: ['architecture.md', 'decisions.md', 'patterns.md'],
      },
    }),
  );
  // Seed one of the three so it is reported present, not missing.
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'patterns.md'), '# Patterns\n');

  const result = scaffoldDocs({ root, write: false });

  assert.deepStrictEqual(result.missing.sort(), [
    'architecture.md',
    'decisions.md',
  ]);
  assert.deepStrictEqual(result.present, ['patterns.md']);
  assert.deepStrictEqual(result.created, []);
  // Detection-only pass must not touch the filesystem.
  assert.strictEqual(
    fs.existsSync(path.join(root, 'docs', 'architecture.md')),
    false,
  );
});

test('on acceptance, creates a stub for each missing docsContextFile under the docs root', () => {
  const root = track(
    makeProject({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles: ['architecture.md', 'decisions.md'],
      },
    }),
  );

  const result = scaffoldDocs({ root, write: true });

  assert.deepStrictEqual(result.created.sort(), [
    'architecture.md',
    'decisions.md',
  ]);
  for (const fileName of ['architecture.md', 'decisions.md']) {
    const target = path.join(root, 'docs', fileName);
    assert.strictEqual(fs.existsSync(target), true, `${fileName} created`);
    const body = fs.readFileSync(target, 'utf8');
    // The MANDREL:STUB marker is prepended before the heading — match anywhere.
    assert.match(body, /# /, `${fileName} has a heading`);
    assert.ok(body.length > 0, `${fileName} is non-empty`);
  }
});

test('a docsContextFile without a dedicated template gets a generic stub', () => {
  const root = track(
    makeProject({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles: ['data-dictionary.md'],
      },
    }),
  );

  const result = scaffoldDocs({ root, write: true });

  assert.deepStrictEqual(result.created, ['data-dictionary.md']);
  const body = fs.readFileSync(
    path.join(root, 'docs', 'data-dictionary.md'),
    'utf8',
  );
  // Title is derived from the slug.
  assert.match(body, /# Data Dictionary/);
  assert.match(body, /mandrel init/);
});

test('every scaffolded stub carries the MANDREL:STUB marker', async () => {
  const { STUB_MARKER } = await import(
    '../../.agents/scripts/lib/onboard/scaffold-docs.js'
  );
  const root = track(
    makeProject({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles: ['architecture.md', 'decisions.md'],
      },
    }),
  );

  scaffoldDocs({ root, write: true });

  for (const fileName of ['architecture.md', 'decisions.md']) {
    const body = fs.readFileSync(path.join(root, 'docs', fileName), 'utf8');
    assert.ok(
      body.includes(STUB_MARKER),
      `${fileName} should carry the MANDREL:STUB marker`,
    );
  }
});

test('does not overwrite an already-present docsContextFile', () => {
  const root = track(
    makeProject({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles: ['architecture.md'],
      },
    }),
  );
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const original = '# My real architecture\n';
  fs.writeFileSync(path.join(root, 'docs', 'architecture.md'), original);

  const result = scaffoldDocs({ root, write: true });

  assert.deepStrictEqual(result.missing, []);
  assert.deepStrictEqual(result.created, []);
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'docs', 'architecture.md'), 'utf8'),
    original,
  );
});

test('respects an override docsContextFiles list', () => {
  const root = track(
    makeProject({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles: ['architecture.md'],
      },
    }),
  );

  const result = scaffoldDocs({
    root,
    docsContextFiles: ['custom-guide.md'],
    write: false,
  });

  assert.deepStrictEqual(result.docsContextFiles, ['custom-guide.md']);
  assert.deepStrictEqual(result.missing, ['custom-guide.md']);
});
