/**
 * transpile-consumer-resolution.test.js — Story #5692.
 *
 * A consumer that installs `typescript` only inside a nested workspace
 * package (`packages/web/node_modules/typescript`) gets that package's TS
 * scored by the CRAP and maintainability gates, with no root install and no
 * `NODE_PATH`. A package with no compiler fails both refresh commands loud,
 * naming the package and the remedy, and leaves the baseline byte-identical.
 *
 * The fixture lives under the OS temp dir, so no ancestor `node_modules`
 * holds a compiler. Mandrel's own module location still would (this repo
 * installs typescript), so a `--require` preload refuses `typescript` for
 * any request issued from inside this repository — the position a consumer's
 * `node_modules/mandrel` is in when the peer is not installed at its root.
 * Same simulation as `tests/scripts/duplication-jscpd-optional-peer.test.js`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SCRIPTS = path.join(REPO_ROOT, '.agents', 'scripts');
const REAL_TS = fs.realpathSync(
  path.join(REPO_ROOT, 'node_modules', 'typescript'),
);
const REAL_TS_VERSION = JSON.parse(
  fs.readFileSync(path.join(REAL_TS, 'package.json'), 'utf8'),
).version;

const BLOCK_MODULE_LOCATION_TS = `
const Module = require('node:module');
const repo = ${JSON.stringify(REPO_ROOT)};
const original = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const from = (parent && parent.filename) || '';
  if ((request === 'typescript' || request.startsWith('typescript/')) && from.startsWith(repo)) {
    const err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return original.call(this, request, parent, ...rest);
};
`;

const TS_SOURCE = `type Mode = 'a' | 'b';

export function pick(mode: Mode, n: number): number {
  if (mode === 'a') {
    return n + 1;
  }
  if (n > 10) {
    return n * 2;
  }
  return n;
}
`;

/** 100%-covered istanbul entry for `pick` at its real source line (3). */
function coverageEntry(absPath) {
  const statementMap = {};
  const s = {};
  for (let i = 0; i < 6; i += 1) {
    statementMap[String(i)] = {
      start: { line: 4 + i, column: 0 },
      end: { line: 4 + i, column: 10 },
    };
    s[String(i)] = 1;
  }
  return {
    path: absPath,
    fnMap: {
      0: {
        name: 'pick',
        decl: { start: { line: 3, column: 0 } },
        loc: { start: { line: 3, column: 0 }, end: { line: 11, column: 1 } },
        line: 3,
      },
    },
    f: { 0: 1 },
    statementMap,
    s,
    branchMap: {},
    b: {},
  };
}

let root;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/**
 * @param {{ withCompilerless?: boolean }} [opts] Adds `packages/api`, whose
 *   TS has no compiler anywhere on its resolution path.
 */
function seed({ withCompilerless = false } = {}) {
  root = fs.realpathSync(makeTempDir('ts-nested-resolution-'));
  const write = (rel, text) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
  };
  write('package.json', JSON.stringify({ name: 'fixture', private: true }));
  write('block-ts.cjs', BLOCK_MODULE_LOCATION_TS);
  // Each workspace package is a target dir (the Spec's `APP/frontend`
  // shape), so the transpiler stamp anchors where the scorer resolves.
  const targetDirs = ['packages/web', 'packages/api'];
  write(
    '.agentrc.json',
    JSON.stringify({
      project: {
        baseBranch: 'main',
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      },
      delivery: {
        quality: {
          gates: {
            crap: { enabled: true, targetDirs },
            maintainability: { enabled: true, targetDirs },
          },
        },
      },
    }),
  );
  write('packages/web/package.json', JSON.stringify({ name: 'web' }));
  fs.mkdirSync(path.join(root, 'packages/web/node_modules'), {
    recursive: true,
  });
  fs.symlinkSync(
    REAL_TS,
    path.join(root, 'packages/web/node_modules/typescript'),
    'junction',
  );
  const files = [write('packages/web/src/a.ts', TS_SOURCE)];
  if (withCompilerless) {
    write('packages/api/package.json', JSON.stringify({ name: 'api' }));
    files.push(write('packages/api/src/b.ts', TS_SOURCE));
  }
  const coverage = Object.fromEntries(
    files.map((abs) => [abs, coverageEntry(abs)]),
  );
  write('coverage/coverage-final.json', JSON.stringify(coverage));
  return files;
}

function childEnv() {
  // `resolveConfig()` defaults to the script's project; point it at the fixture.
  const env = { ...process.env, NO_COLOR: '1', AP_AGENTRC_CWD: root };
  delete env.NODE_PATH;
  return env;
}

function run(args) {
  return spawnSync(
    process.execPath,
    ['--require', path.join(root, 'block-ts.cjs'), ...args],
    { cwd: root, encoding: 'utf8', env: childEnv() },
  );
}

function readBaseline(kind) {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'baselines', `${kind}.json`), 'utf8'),
  );
}

describe('TypeScript installed only in a nested package (no NODE_PATH)', () => {
  it('the CRAP refresh scores the nested sources and stamps the nested compiler', () => {
    seed();
    const res = run([
      path.join(SCRIPTS, 'update-crap-baseline.js'),
      '--full-scope',
    ]);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    const baseline = readBaseline('crap');
    const rows = baseline.rows.filter(
      (r) => r.path === 'packages/web/src/a.ts',
    );
    assert.ok(rows.length > 0, JSON.stringify(baseline));
    assert.ok(rows.every((r) => typeof r.crap === 'number' && r.crap > 0));
    assert.equal(baseline.tsTranspilerVersion, REAL_TS_VERSION);
    assert.notEqual(baseline.tsTranspilerVersion, '0.0.0');
  });

  it('the maintainability refresh scores the nested sources', () => {
    seed();
    const res = run([
      path.join(SCRIPTS, 'update-maintainability-baseline.js'),
      '--full-scope',
    ]);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    const row = readBaseline('maintainability').rows.find(
      (r) => r.path === 'packages/web/src/a.ts',
    );
    assert.ok(row, 'a.ts has a maintainability row');
    assert.ok(row.mi > 0, `real score, got ${row.mi}`);
  });
});

describe('a package with no resolvable compiler fails loud', () => {
  for (const [kind, script] of [
    ['crap', 'update-crap-baseline.js'],
    ['maintainability', 'update-maintainability-baseline.js'],
  ]) {
    it(`the ${kind} refresh exits non-zero naming the package and leaves the baseline byte-identical`, () => {
      seed({ withCompilerless: true });
      const committed = '{"sentinel":"committed bytes"}\n';
      fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
      const baselinePath = path.join(root, 'baselines', `${kind}.json`);
      fs.writeFileSync(baselinePath, committed);

      const res = run([path.join(SCRIPTS, script), '--full-scope']);
      const output = `${res.stdout}${res.stderr}`;
      assert.notEqual(res.status, 0, output);
      // Only the compilerless package is named; `web` still resolves.
      assert.match(output, /1 package\(s\): packages\/api\./);
      assert.match(output, /npm install --save-dev typescript/);
      assert.doesNotMatch(output, /\n\s+at /, 'no stack trace');
      assert.equal(fs.readFileSync(baselinePath, 'utf8'), committed);
    });
  }

  it('a miss in one package never stops resolution in another', () => {
    const [webFile, apiFile] = seed({ withCompilerless: true });
    const probe = path.join(root, 'probe.mjs');
    fs.writeFileSync(
      probe,
      `import { transpileIfNeeded, isCompilerMissing } from ${JSON.stringify(
        pathToFileURL(path.join(SCRIPTS, 'lib', 'transpile.js')).href,
      )};
const src = 'const x: number = 1;';
const out = [${JSON.stringify(apiFile)}, ${JSON.stringify(webFile)}, ${JSON.stringify(apiFile)}]
  .map((f) => { const r = transpileIfNeeded(f, src); return isCompilerMissing(r) ? 'missing' : typeof r; });
process.stdout.write(JSON.stringify(out));
`,
    );
    const res = run([probe]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), ['missing', 'string', 'missing']);
  });
});
