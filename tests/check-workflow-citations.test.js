/**
 * tests/check-workflow-citations.test.js — the provenance-citation report.
 *
 * Workflow prose is resident context: a `(Story #1234)` aside is charged at
 * the same rate as instruction and teaches the model Mandrel's own history
 * instead of the task. Story #5340 demoted the ratchet that guarded the
 * count to a report, because failing on a rise meant a prose fix had to be
 * paid for with an unrelated trim in the same commit — the freeze that let
 * three reference sections describe retired mechanisms.
 *
 * What has to hold now is the mirror of what held before:
 *
 *   1. The report NEVER fails. Any count exits 0, and no baseline file is
 *      read — `baselines/workflow-citations.json` is gone.
 *   2. The count is still honest and per-file, so the measurement a reader
 *      acts on survives the demotion.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectMarkdownFiles,
  countCitations,
  parseArgv,
  renderReport,
  runCli,
  tallyCitations,
} from '../.agents/scripts/check-workflow-citations.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const tempRoots = [];

/** Build a throwaway repo-shaped fixture: `.agents/workflows` and nothing else. */
function makeFixture({ docs = {} } = {}) {
  const root = makeTempDir('workflow-citations-');
  tempRoots.push(root);
  const workflows = path.join(root, '.agents', 'workflows');
  fs.mkdirSync(workflows, { recursive: true });
  for (const [name, body] of Object.entries(docs)) {
    const full = path.join(workflows, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

/** Capture stdout/stderr writes for assertion. */
function capture() {
  const chunks = { out: '', err: '' };
  return {
    chunks,
    stdout: {
      write: (s) => {
        chunks.out += s;
      },
    },
    stderr: {
      write: (s) => {
        chunks.err += s;
      },
    },
  };
}

after(() => {
  for (const root of tempRoots)
    fs.rmSync(root, { recursive: true, force: true });
});

describe('countCitations', () => {
  it('counts both the prefixed and the bare spelling of one citation', () => {
    assert.equal(countCitations('see (Story #4593) and also (#4722)'), 2);
  });

  it('ignores markdown headings, anchors, and short numbers', () => {
    assert.equal(countCitations('### Step 3\nsee {#recover} and gate #2'), 0);
  });
});

describe('tallyCitations', () => {
  it('omits clean files and relativizes paths against cwd', () => {
    const root = makeFixture({
      docs: { 'a.md': 'refs #1234 and #5678', 'b.md': 'no citations here' },
    });
    const tally = tallyCitations(
      collectMarkdownFiles(path.join(root, '.agents', 'workflows')),
      root,
    );
    assert.equal(tally.total, 2);
    assert.deepEqual(tally.files, [
      { path: '.agents/workflows/a.md', count: 2 },
    ]);
  });
});

describe('renderReport', () => {
  it('names every citing file and says the count is never gated', () => {
    const out = renderReport({
      total: 3,
      files: [
        { path: 'a.md', count: 2 },
        { path: 'b.md', count: 1 },
      ],
    });
    assert.match(out, /a\.md: 2/);
    assert.match(out, /b\.md: 1/);
    assert.match(out, /total=3 across 2 file\(s\)/);
    assert.match(out, /never gated/);
  });
});

describe('parseArgv', () => {
  it('parses every documented flag', () => {
    assert.deepEqual(parseArgv(['--root', 'r', '--json']), {
      rootPath: 'r',
      json: true,
    });
  });

  it('no longer accepts the retired baseline flags', () => {
    // `--baseline` / `--update` described a committed ceiling that no longer
    // exists; they must not silently swallow the next argument either.
    assert.deepEqual(parseArgv(['--baseline', 'b.json', '--update']), {
      rootPath: null,
      json: false,
    });
  });
});

describe('runCli', () => {
  it('exits 0 however high the count rises — the report never gates', async () => {
    const root = makeFixture({
      docs: { 'a.md': 'refs #1234 #5678 #9012 #3456 #7890' },
    });
    const cap = capture();
    assert.equal(await runCli({ argv: [], cwd: root, ...cap }), 0);
    assert.match(cap.chunks.out, /a\.md: 5/);
    assert.match(cap.chunks.out, /total=5/);
  });

  it('reads no baseline — a committed one is neither required nor consulted', async () => {
    const root = makeFixture({ docs: { 'a.md': 'refs #1234 and #5678' } });
    // A baseline file that would have failed the old ratchet outright.
    fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'baselines', 'workflow-citations.json'),
      `${JSON.stringify({ total: 0, files: [] }, null, 2)}\n`,
    );
    const cap = capture();
    assert.equal(await runCli({ argv: [], cwd: root, ...cap }), 0);
    assert.equal(cap.chunks.err, '');
    assert.doesNotMatch(cap.chunks.out, /baseline/);
  });

  it('--json emits the machine-readable envelope with no baseline fields', async () => {
    const root = makeFixture({ docs: { 'a.md': 'refs #1234' } });
    const cap = capture();
    assert.equal(await runCli({ argv: ['--json'], cwd: root, ...cap }), 0);
    const envelope = JSON.parse(cap.chunks.out);
    assert.equal(envelope.kind, 'workflow-citations-report');
    assert.equal(envelope.total, 1);
    assert.equal(envelope.exitCode, 0);
    assert.ok(!('baselineTotal' in envelope));
    assert.ok(!('delta' in envelope));
  });

  it('throws when the workflow root is missing rather than passing vacuously', async () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, '.agents', 'workflows'), { recursive: true });
    await assert.rejects(
      () => runCli({ argv: [], cwd: root, ...capture() }),
      /workflow root not found/,
    );
  });
});

describe('the demotion is complete in this repo', () => {
  it('reports the live corpus and exits 0 with no committed baseline present', async () => {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, 'baselines/workflow-citations.json')),
      false,
      'baselines/workflow-citations.json must be deleted — nothing reads it any more',
    );
    const cap = capture();
    assert.equal(await runCli({ argv: [], cwd: REPO_ROOT, ...cap }), 0);
    assert.match(cap.chunks.out, /\[workflow-citations\] total=\d+/);
  });
});
