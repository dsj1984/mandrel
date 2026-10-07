/**
 * The engine's contract as a CLI: read-only (the working tree and index are
 * byte-identical before and after a run, with and without `--probe`), a
 * schema-valid envelope at exit 0 even on a repo with nothing installed, and
 * the scope rules that keep it useful in a consumer — the materialized
 * `.agents/` payload and gitignored files never produce a record.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertEnvelope, runCli } from '../../../audit-exceptions.js';
import { GhNotInstalledError } from '../../gh-exec.js';
import { gitSync } from '../../git-utils.js';
import { makeTempDir } from '../../test-temp.js';
import { fakeGh, lines, makeRepo } from './fixtures/repo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → audit-exceptions → lib → scripts → .agents → repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

const quiet = { write: () => {} };
const noGh = {
  api: async () => {
    throw new GhNotInstalledError('gh: command not found', { args: [] });
  },
};

async function run(root, extra = [], opts = {}) {
  const out = path.join(makeTempDir('audit-exceptions-out-'), 'env.json');
  const code = await runCli({
    argv: ['--out', out, '--cwd', root, ...extra],
    stdout: quiet,
    gh: opts.gh ?? fakeGh({}),
    spawn: opts.spawn,
  });
  return { code, env: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

/** SHA-256 over every file outside `.git/` plus the index's staged entries. */
function snapshot(root) {
  const hash = createHash('sha256');
  const walk = (dir) => {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile())
        hash.update(path.relative(root, abs)).update(fs.readFileSync(abs));
    }
  };
  walk(root);
  hash.update(gitSync(root, 'ls-files', '-s'));
  return hash.digest('hex');
}

const SUPPRESSIONS = lines(
  '// biome-ignore lint/suspicious/noDebugger: stale',
  'const a = 1;',
  'export { a };',
);

describe('read-only invariant', () => {
  // The live checkout is shared with every concurrently running test file, so
  // only an isolated fixture can prove the engine wrote nothing.
  it('writes a schema-valid envelope for this repository', async () => {
    const { code, env } = await run(REPO_ROOT);
    assert.equal(code, 0);
    assert.doesNotThrow(() => assertEnvelope(env));
    assert.equal(env.kind, 'audit-exceptions-envelope');
    assert.equal(env.isFrameworkSource, true);
  });

  it('leaves a fixture byte-identical without --probe', async () => {
    const root = makeRepo({
      'package.json': { name: 'c', overrides: { x: '^1.0.0' } },
      'src/a.js': SUPPRESSIONS,
      'tests/a.test.js': "test.skip('x', () => {});\n",
    });
    const before = snapshot(root);
    const { code, env } = await run(root, ['--changed-since', 'HEAD']);
    assert.equal(code, 0);
    assert.ok(env.records.length >= 3);
    assert.equal(snapshot(root), before);
  });

  it('leaves a fixture byte-identical with --probe running a real installed tool', async () => {
    const root = makeRepo({
      'biome.json': { linter: { enabled: true } },
      'src/a.js': SUPPRESSIONS,
    });
    const realBiome = path.join(REPO_ROOT, 'node_modules', '@biomejs', 'biome');
    fs.mkdirSync(path.join(root, 'node_modules', '@biomejs'), {
      recursive: true,
    });
    fs.symlinkSync(
      realBiome,
      path.join(root, 'node_modules', '@biomejs', 'biome'),
      'junction',
    );
    const before = snapshot(root);
    const { code, env } = await run(root, ['--probe']);
    assert.equal(code, 0);
    assert.equal(snapshot(root), before);
    const record = env.records.find((r) => r.file === 'src/a.js');
    assert.equal(
      record.verdict,
      'dead',
      'biome reports the suppression as unused',
    );
    assert.equal(record.verdictBasis, 'tool');
    assert.deepEqual(env.probes, [{ id: 'biome', flagged: 1 }]);
  });
});

describe('exit codes', () => {
  it('rejects a run without --out', async () => {
    await assert.rejects(
      () => runCli({ argv: ['--cwd', REPO_ROOT], stdout: quiet }),
      /--out <path> is required/,
    );
  });

  it('fails when the envelope cannot be written', async () => {
    const root = makeRepo({ 'a.txt': 'x\n' });
    const blocker = path.join(makeTempDir('audit-exceptions-blk-'), 'file');
    fs.writeFileSync(blocker, '');
    await assert.rejects(() =>
      runCli({
        argv: ['--out', path.join(blocker, 'env.json'), '--cwd', root],
        stdout: quiet,
        gh: fakeGh({}),
      }),
    );
  });
});

describe('scope', () => {
  it('excludes the materialized .agents/ payload in a consumer repo', async () => {
    const root = makeRepo({
      'package.json': { name: 'consumer-app' },
      '.agents/scripts/x.js': SUPPRESSIONS,
      'src/a.js': SUPPRESSIONS,
    });
    const { env } = await run(root);
    assert.equal(env.isFrameworkSource, false);
    assert.ok(env.records.some((r) => r.file === 'src/a.js'));
    assert.ok(env.records.every((r) => !r.file.startsWith('.agents/')));
  });

  it('keeps .agents/ in scope in the framework source repo', async () => {
    const root = makeRepo({
      'package.json': { name: 'mandrel' },
      '.agents/scripts/x.js': SUPPRESSIONS,
    });
    const { env } = await run(root);
    assert.ok(env.records.some((r) => r.file === '.agents/scripts/x.js'));
  });

  it('never reads gitignored or untracked files, local overrides included', async () => {
    const root = makeRepo(
      {
        '.gitignore': lines('.agentrc.local.json', 'local/'),
        'package.json': { name: 'c' },
      },
      {
        untracked: {
          '.agentrc.local.json': { overrides: { x: '1.0.0' } },
          'local/a.js': SUPPRESSIONS,
          'scratch.js': SUPPRESSIONS,
        },
      },
    );
    const { env } = await run(root);
    assert.deepEqual(
      env.records.map((r) => r.file),
      [],
    );
  });
});

describe('a toolless repo', () => {
  it('exits 0, names every missing input, and lists every inapplicable adapter', async () => {
    const root = makeRepo({
      'package.json': {
        name: 'bare',
        dependencies: { left: '^1.0.0' },
        overrides: { left: '^1.1.0' },
      },
      'src/a.js': lines(
        '// eslint-disable-next-line no-x -- remove once #7 lands',
        'export const a = 1;',
      ),
    });
    const { code, env } = await run(root, [], { gh: noGh });
    assert.equal(code, 0);
    const inputs = env.degradations.map((d) => d.input);
    for (const input of [
      'lockfile',
      'dependency-manifests-unavailable',
      'origin',
    ]) {
      assert.ok(
        inputs.includes(input),
        `${input} degradation missing: ${inputs}`,
      );
    }
    const skipped = env.skipped.map((s) => s.id);
    assert.ok(skipped.includes('ci-gates') && skipped.includes('test-skips'));
    assert.equal(
      env.records.find((r) => r.target === 'left').probeBasis,
      'redundancy-unprobed',
    );
  });

  it('degrades on a missing gh instead of failing', async () => {
    const root = makeRepo(
      {
        'src/a.js': lines(
          '// eslint-disable-next-line no-x -- remove once #7 lands',
          'export const a = 1;',
        ),
      },
      { origin: 'https://github.com/acme/app.git' },
    );
    const { code, env } = await run(root, [], { gh: noGh });
    assert.equal(code, 0);
    assert.ok(env.degradations.some((d) => d.input === 'gh'));
    assert.equal(env.records[0].verdict, 'live');
  });

  it('runs outside a git repository with a git degradation', async () => {
    const { code, env } = await run(makeTempDir('audit-exceptions-nogit-'));
    assert.equal(code, 0);
    assert.ok(env.degradations.some((d) => d.input === 'git'));
    assert.equal(env.records.length, 0);
  });
});

describe('history', () => {
  it('a new override for an already-declared dependency is introduced on its own line', async () => {
    const root = makeRepo({
      'package.json': { name: 'c', dependencies: { 'js-yaml': '^4.3.2' } },
    });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'c', dependencies: { 'js-yaml': '^4.3.2' }, overrides: { 'js-yaml': '^4.3.2' } }, null, 2)}\n`,
    );
    gitSync(
      root,
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=T',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qam',
      'pin',
    );
    const { env } = await run(root, ['--changed-since', 'HEAD~1']);
    const pin = env.records.find((r) => r.surface === 'npm-overrides');
    assert.equal(
      pin.line,
      7,
      'the overrides entry, not the dependencies entry',
    );
    assert.equal(pin.introduced, true);
  });

  it('--changed-since marks only lines added since the ref', async () => {
    const root = makeRepo({ 'src/a.js': SUPPRESSIONS });
    fs.appendFileSync(
      path.join(root, 'src/a.js'),
      '// eslint-disable-next-line no-new\n',
    );
    gitSync(root, 'add', '-A');
    gitSync(
      root,
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=T',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'add',
    );
    const { env } = await run(root, ['--changed-since', 'HEAD~1']);
    assert.deepEqual(
      env.records.map((r) => [r.line, r.introduced]),
      [
        [1, false],
        [4, true],
      ],
    );
    assert.equal(env.totals.introduced, 1);
    assert.match(env.records[0].addedAt, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('an unknown ref degrades and leaves introduced false', async () => {
    const root = makeRepo({ 'src/a.js': SUPPRESSIONS });
    const { env } = await run(root, ['--changed-since', 'no-such-ref']);
    assert.ok(env.degradations.some((d) => d.input === 'changed-since'));
    assert.ok(env.records.every((r) => r.introduced === false));
  });

  it('caps blame and records with notes, while clusters still count every record', async () => {
    const root = makeRepo({ 'src/a.js': lines(SUPPRESSIONS, SUPPRESSIONS) });
    const { env } = await run(root, [
      '--max-records',
      '1',
      '--blame-limit',
      '0',
    ]);
    assert.deepEqual(env.truncated, { kept: 1, dropped: 1 });
    assert.equal(env.records.length, 1);
    assert.equal(env.records[0].addedAt, null);
    assert.equal(env.clusters[0].count, 2);
    assert.ok(env.degradations.some((d) => d.input === 'blame-limit'));
  });
});
