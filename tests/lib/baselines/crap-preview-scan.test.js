import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { computeCrapPreviewScan } from '../../../.agents/scripts/lib/baselines/crap-preview-scan.js';
import {
  computeContentDigest,
  computeTreeDigest,
  writeCaptureStamp,
} from '../../../.agents/scripts/lib/coverage-capture.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const COVERAGE = 'coverage/coverage-final.json';
const REL = 'src/mod.js';
const branchy = (name) =>
  [
    `export function ${name}(n) {`,
    "  if (n < 0) return 'a';",
    "  if (n === 0) return 'b';",
    "  if (n < 10) return 'c';",
    "  return 'd';",
    '}',
  ].join('\n');
const SOURCE = `${branchy('edited')}\n\n${branchy('neighbour')}\n`;
const SPANS = { edited: [1, 6], neighbour: [8, 13] };

function entryFor(abs) {
  const statementMap = {};
  const s = {};
  const fnMap = {};
  const f = {};
  for (const [id, [name, [start, end]]] of Object.entries(SPANS).entries()) {
    fnMap[id] = {
      name,
      decl: {
        start: { line: start, column: 0 },
        end: { line: start, column: 9 },
      },
      loc: { start: { line: start, column: 0 }, end: { line: end, column: 1 } },
    };
    f[id] = 0;
    statementMap[id] = {
      start: { line: start, column: 0 },
      end: { line: end, column: 1 },
    };
    s[id] = 0;
  }
  return { path: abs, statementMap, s, fnMap, f, branchMap: {}, b: {} };
}

function gitCommitAll(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed');
}

function plant({ artifact = true, stamp = true } = {}) {
  const cwd = fs.realpathSync(makeTempDir('crap-preview-scan-'));
  fs.mkdirSync(path.join(cwd, 'src'));
  const abs = path.join(cwd, REL);
  fs.writeFileSync(abs, SOURCE);
  if (artifact) {
    fs.mkdirSync(path.join(cwd, 'coverage'));
    fs.writeFileSync(
      path.join(cwd, COVERAGE),
      JSON.stringify({ [abs]: entryFor(abs) }),
    );
  }
  if (artifact && stamp) {
    gitCommitAll(cwd);
    writeCaptureStamp({
      cwd,
      coveragePath: COVERAGE,
      digest: computeContentDigest(cwd, ['src']),
      treeDigest: computeTreeDigest(cwd, COVERAGE),
    });
  }
  return cwd;
}

const crapConfig = (extra = {}) => ({
  targetDirs: ['src'],
  ignoreGlobs: [],
  requireCoverage: true,
  newMethodCeiling: 30,
  tolerance: 0,
  coveragePath: COVERAGE,
  ...extra,
});
const REGRESSED_BASELINE = {
  rows: ['edited', 'neighbour'].map((method) => ({
    file: REL,
    method,
    crap: 1,
  })),
};
const hunkGit = (diff) => (_cwd, verb) =>
  verb === 'merge-base'
    ? { status: 0, stdout: 'base\n' }
    : { status: 0, stdout: diff };
const EDITED_HUNK = `diff --git a/${REL} b/${REL}\n--- a/${REL}\n+++ b/${REL}\n@@ -2 +2 @@\n-old\n+new\n`;

const scan = (cwd, crap, git) =>
  computeCrapPreviewScan({
    crap,
    cwd,
    scopeSet: new Set([REL]),
    scope: 'diff',
    diffRef: 'origin/main',
    baseline: REGRESSED_BASELINE,
    ...(git ? { git } : {}),
  });

describe('CRAP preview without a fresh artifact', () => {
  it('AC-1: no artifact scores nothing, names why in one diagnostic, exits 0', async () => {
    const { exitCode, envelope } = await scan(
      plant({ artifact: false }),
      crapConfig(),
    );
    assert.equal(exitCode, 0);
    assert.deepEqual(envelope.violations, []);
    assert.equal(envelope.diagnostics.length, 1);
    assert.match(
      envelope.diagnostics[0].message,
      /CRAP half did not run: no coverage artifact/,
    );
  });

  it('AC-1: an artifact that does not match the tree is not joined', async () => {
    const cwd = plant();
    fs.appendFileSync(path.join(cwd, REL), '\nexport const moved = 1;\n');
    const { exitCode, envelope } = await scan(cwd, crapConfig());
    assert.equal(exitCode, 0);
    assert.match(
      envelope.diagnostics[0].message,
      /does not match the current tree/,
    );
  });

  it('a fresh artifact is scored as before', async () => {
    const { exitCode, envelope } = await scan(plant(), crapConfig());
    assert.equal(exitCode, 1);
    assert.equal(envelope.violations.length, 2);
  });
});

describe('crap.previewScope: touched-methods', () => {
  const touched = crapConfig({ previewScope: 'touched-methods' });

  it('AC-6: judges the edited method, reports its neighbour informationally', async () => {
    const { exitCode, envelope } = await scan(
      plant(),
      touched,
      hunkGit(EDITED_HUNK),
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(
      envelope.violations.map((v) => v.method),
      ['edited'],
    );
    assert.match(envelope.diagnostics[0].message, /informational: .*neighbour/);
  });

  it('AC-6: a regression only outside the hunks exits 0', async () => {
    const outside = EDITED_HUNK.replace('@@ -2 +2 @@', '@@ -7 +7 @@');
    const { exitCode, envelope } = await scan(
      plant(),
      touched,
      hunkGit(outside),
    );
    assert.equal(exitCode, 0);
    assert.deepEqual(envelope.violations, []);
    assert.equal(envelope.diagnostics.length, 2);
  });

  it('fails closed: unreadable hunks or a file absent from the diff are judged', async () => {
    const unreadable = () => ({ status: 128, stdout: '' });
    assert.equal((await scan(plant(), touched, unreadable)).exitCode, 1);
    const other = EDITED_HUNK.replaceAll(REL, 'src/other.js');
    const absent = await scan(plant(), touched, hunkGit(other));
    assert.equal(absent.envelope.violations.length, 2);
  });

  it('a new method still faces the ceiling', async () => {
    const cwd = plant();
    const result = await computeCrapPreviewScan({
      crap: { ...touched, newMethodCeiling: 1 },
      cwd,
      scopeSet: new Set([REL]),
      scope: 'diff',
      diffRef: 'origin/main',
      baseline: { rows: [] },
      git: hunkGit(EDITED_HUNK.replace('@@ -2 +2 @@', '@@ -7 +7 @@')),
    });
    assert.equal(result.envelope.summary.newViolations, 2);
  });

  it('AC-6: the default file scope judges every method', async () => {
    const { envelope } = await scan(
      plant(),
      crapConfig(),
      hunkGit(EDITED_HUNK),
    );
    assert.equal(envelope.violations.length, 2);
  });
});

describe('touched-methods diff parsing', () => {
  it('skips a deleted file and a hunk body line shaped like a file header', async () => {
    const diff = [
      '--- a/gone.js',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      `--- a/${REL}`,
      `+++ b/${REL}`,
      '@@ -1 +9,2 @@',
      '-old',
      '+++ b/fake.js',
      '+new',
      '@@ -20,2 +14,0 @@',
      '-c',
      '-d',
    ].join('\n');
    const { envelope } = await scan(
      plant(),
      crapConfig({ previewScope: 'touched-methods' }),
      hunkGit(diff),
    );
    assert.deepEqual(
      envelope.violations.map((v) => v.method),
      ['neighbour'],
    );
  });
});
