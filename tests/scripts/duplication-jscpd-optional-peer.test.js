/**
 * duplication-jscpd-optional-peer.test.js — Story #5672.
 *
 * jscpd is an optional peer dependency: a consumer installs it only when it
 * enables the duplication gate. Pins:
 *
 *   - `package.json` declares it as an optional peer (still a devDependency
 *     for this repo's own gate);
 *   - the refresh (`update-duplication-baseline.js`) fails with one
 *     actionable `npm i -D jscpd@^4` line, no stack trace, when jscpd cannot
 *     resolve;
 *   - the check (`check-baselines --gate duplication`) evaluates the
 *     committed baseline and never loads jscpd, so it passes without it.
 *
 * "Unresolvable" is simulated with a `--require` preload that refuses the
 * `jscpd` specifier: removing the package is not enough here, because a
 * worktree nested in the main checkout resolves through to the parent's
 * `node_modules`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  JSCPD_MISSING,
  resolveDetectClones,
} from '../../.agents/scripts/lib/baselines/duplication-scanner.js';
import { currentKernelVersion } from '../../.agents/scripts/lib/baselines/kernel.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SCRIPTS = path.join(REPO_ROOT, '.agents', 'scripts');

const BLOCK_JSCPD = `
const Module = require('node:module');
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'jscpd' || request.startsWith('jscpd/')) {
    const err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return original.call(this, request, ...rest);
};
`;

function moduleNotFound() {
  const err = new Error("Cannot find module 'jscpd'");
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

describe('resolveDetectClones — missing optional peer', () => {
  it('names the install step when jscpd cannot resolve', () => {
    assert.throws(
      () =>
        resolveDetectClones(() => {
          throw moduleNotFound();
        }),
      (err) =>
        err.code === JSCPD_MISSING && err.message.includes('npm i -D jscpd@^4'),
    );
  });

  it('propagates any other load failure unchanged', () => {
    const boom = new Error('broken transitive import');
    assert.throws(
      () =>
        resolveDetectClones(() => {
          throw boom;
        }),
      (err) => err === boom,
    );
  });
});

describe('package.json — jscpd is an optional peer', () => {
  it('declares jscpd ^4 as an optional peer dependency', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    assert.match(pkg.peerDependencies.jscpd, /^\^4/);
    assert.deepEqual(pkg.peerDependenciesMeta.jscpd, { optional: true });
  });
});

describe('duplication gate without jscpd installed (end to end)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function seed() {
    root = makeTempDir('jscpd-optional-peer-');
    mkdirSync(path.join(root, 'baselines'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'block-jscpd.cjs'), BLOCK_JSCPD);
    writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify({
        project: {
          baseBranch: 'main',
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: {
          quality: {
            gates: {
              duplication: {
                enabled: true,
                baselinePath: 'baselines/duplication.json',
                targetDirs: ['src'],
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      path.join(root, 'baselines', 'duplication.json'),
      JSON.stringify({
        $schema: 'duplication.schema.json',
        kernelVersion: currentKernelVersion('duplication'),
        rows: [],
      }),
    );
  }

  function run(script, args) {
    return spawnSync(
      process.execPath,
      [
        '--require',
        path.join(root, 'block-jscpd.cjs'),
        path.join(SCRIPTS, script),
        ...args,
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
    );
  }

  it('the refresh exits 1 with the install step and no stack trace', () => {
    seed();
    const res = run('update-duplication-baseline.js', ['--full-scope']);
    const output = `${res.stdout}${res.stderr}`;
    assert.equal(res.status, 1, output);
    assert.match(output, /npm i -D jscpd@\^4/);
    assert.doesNotMatch(
      output,
      /\n\s+at /,
      'no stack trace for an install step',
    );
  });

  it('the check evaluates the committed baseline without loading jscpd', () => {
    seed();
    const res = run('check-baselines.js', [
      '--gate',
      'duplication',
      '--no-friction',
    ]);
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  });
});
