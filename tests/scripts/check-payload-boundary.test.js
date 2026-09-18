// tests/scripts/check-payload-boundary.test.js
//
// Story #5381 — the payload-boundary ratchet. Every rule is driven against a
// planted tree under the OS temp dir, so no case touches the shared checkout;
// one case runs the real CLI against this repository.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkPayloadBoundary,
  findEscapingImports,
  findUnnamedClis,
  renderPayloadBoundaryReport,
} from '../../scripts/lib/payload-boundary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'check-payload-boundary.js');

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Plant a repository tree from a `{ relPath: content }` map.
 *
 * @param {Record<string, string>} files
 * @returns {string} absolute root
 */
function plant(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-boundary-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

describe('findUnnamedClis', () => {
  it('reports a CLI no surface names', () => {
    const unnamed = findUnnamedClis({
      clis: ['used.js', 'orphan.js'],
      surfaces: [{ path: '.agents/workflows/a.md', text: 'run `used.js`' }],
    });
    assert.deepEqual(unnamed, ['orphan.js']);
  });

  it('never lets a CLI vouch for itself', () => {
    const unnamed = findUnnamedClis({
      clis: ['self.js'],
      surfaces: [{ path: '.agents/scripts/self.js', text: "'self.js'" }],
    });
    assert.deepEqual(unnamed, ['self.js']);
  });

  it('matches the basename as a whole token, not as a suffix', () => {
    const unnamed = findUnnamedClis({
      clis: ['notify.js'],
      surfaces: [{ path: 'lib/x.js', text: "spawn('my-notify.js')" }],
    });
    assert.deepEqual(unnamed, ['notify.js']);
  });

  it('accepts a path-qualified mention', () => {
    const unnamed = findUnnamedClis({
      clis: ['notify.js'],
      surfaces: [
        { path: 'bin/x.js', text: "join(root, '.agents/scripts/notify.js')" },
      ],
    });
    assert.deepEqual(unnamed, []);
  });
});

describe('findEscapingImports', () => {
  it('reports a relative import that resolves outside .agents/', () => {
    const escapes = findEscapingImports({
      files: [
        {
          path: '.agents/scripts/a.js',
          text: "import { x } from '../../scripts/lib/x.js';",
        },
      ],
    });
    assert.deepEqual(escapes, [
      { file: '.agents/scripts/a.js', specifier: '../../scripts/lib/x.js' },
    ]);
  });

  it('catches dynamic import() and require()', () => {
    const escapes = findEscapingImports({
      files: [
        {
          path: '.agents/scripts/lib/a.js',
          text: "await import('../../../lib/y.js'); require('../../../bin/z.js');",
        },
      ],
    });
    assert.equal(escapes.length, 2);
  });

  it('ignores package specifiers and imports that stay inside .agents/', () => {
    const escapes = findEscapingImports({
      files: [
        {
          path: '.agents/scripts/lib/a.js',
          text: "import fs from 'node:fs';\nimport { b } from '../b.js';",
        },
      ],
    });
    assert.deepEqual(escapes, []);
  });
});

describe('checkPayloadBoundary over a planted tree', () => {
  it('is clean when every CLI is named and nothing escapes', () => {
    const root = plant({
      '.agents/scripts/tool.js': 'export {};\n',
      '.agents/workflows/run.md': 'Run `node .agents/scripts/tool.js`.\n',
    });
    const report = checkPayloadBoundary({ repoRoot: root });
    assert.deepEqual(report, { clis: 1, unnamed: [], escapes: [] });
  });

  it('does not count a code comment or the classifier catalogue as a use', () => {
    const root = plant({
      '.agents/scripts/tool.js': 'export {};\n',
      '.agents/scripts/lib/other.js': '// tool.js is mentioned only here\n',
      '.agents/scripts/lib/observability/source-classifier.js':
        "export const NAMES = ['tool.js'];\n",
    });
    const report = checkPayloadBoundary({ repoRoot: root });
    assert.deepEqual(report.unnamed, ['tool.js']);
  });

  it('skips test files as surfaces', () => {
    const root = plant({
      '.agents/scripts/tool.js': 'export {};\n',
      '.agents/scripts/lib/__tests__/tool.test.js': "import '../../tool.js';\n",
    });
    const report = checkPayloadBoundary({ repoRoot: root });
    assert.deepEqual(report.unnamed, ['tool.js']);
  });

  it('reports a payload file importing contributor code', () => {
    const root = plant({
      '.agents/scripts/tool.js':
        "import { x } from '../../scripts/lib/x.js';\nexport { x };\n",
      '.agents/skills/s/SKILL.md': 'Uses tool.js.\n',
      'scripts/lib/x.js': 'export const x = 1;\n',
    });
    const report = checkPayloadBoundary({ repoRoot: root });
    assert.deepEqual(report.escapes, [
      { file: '.agents/scripts/tool.js', specifier: '../../scripts/lib/x.js' },
    ]);
  });
});

describe('renderPayloadBoundaryReport', () => {
  it('names each violation and closes with a failing summary', () => {
    const text = renderPayloadBoundaryReport({
      clis: 2,
      unnamed: ['orphan.js'],
      escapes: [{ file: '.agents/a.js', specifier: '../x.js' }],
    });
    assert.match(text, /\.agents\/scripts\/orphan\.js — named by no consumer/);
    assert.match(text, /\.agents\/a\.js imports \.\.\/x\.js/);
    assert.match(text, /unnamed=1 escaping-imports=1 \(gate fail\)/);
  });

  it('reports ok when clean', () => {
    const text = renderPayloadBoundaryReport({
      clis: 3,
      unnamed: [],
      escapes: [],
    });
    assert.match(text, /clis=3 unnamed=0 escaping-imports=0 \(ok\)/);
  });
});

describe('check-payload-boundary CLI', () => {
  it('exits 0 against this repository', () => {
    const run = spawnSync(process.execPath, [CLI], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /\(ok\)/);
  });

  it('exits 1 and names the CLI when one is unnamed', () => {
    const root = plant({ '.agents/scripts/orphan.js': 'export {};\n' });
    const run = spawnSync(process.execPath, [CLI, '--cwd', root], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /orphan\.js — named by no consumer surface/);
  });

  it('--help prints usage and scans nothing', () => {
    const run = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    assert.match(
      run.stdout,
      /^Usage: node scripts\/check-payload-boundary\.js/m,
    );
    assert.doesNotMatch(run.stdout, /\[payload-boundary\]/);
  });
});
