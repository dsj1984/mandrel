/**
 * Story #5955 — `coverage-ratchet.js` adopts a CI-produced coverage artifact
 * at the checked-out HEAD and runs the coverage and CRAP value ratchet over
 * it. It refuses a foreign head, a dirty tracked tree and an unreadable
 * artifact; once adopted the artifact seats CRAP rows like a local capture.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCrapSeatScorer,
  resolveCrapUpdaterOptions,
} from '../../.agents/scripts/lib/baselines/crap-updater-cli.js';
import { loadFile } from '../../.agents/scripts/lib/baselines/reader.js';
import { seatMissingBaseline } from '../../.agents/scripts/lib/baselines/seat-missing.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from '../../.agents/scripts/lib/baselines/writer.js';
import { resolveQuality } from '../../.agents/scripts/lib/config/quality.js';
import {
  captureStampPath,
  isCoverageFresh,
} from '../../.agents/scripts/lib/coverage-capture.js';
import {
  adoptArtifact,
  parseRatchetArgs,
  ratchetSteps,
  scoreRatchet,
} from '../../.agents/scripts/lib/coverage-ratchet.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const CLI = fileURLToPath(
  new URL('../../.agents/scripts/coverage-ratchet.js', import.meta.url),
);
const COVERAGE_PATH = 'coverage/coverage-final.json';
const QUALITY = resolveQuality({
  gates: { crap: { targetDirs: ['src'] }, coverage: {} },
});

/** A committed repo with one source file and a CI artifact beside it. */
function repo() {
  const cwd = fs.realpathSync(makeTempDir('coverage-ratchet-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 'ratchet@test.local');
  git('config', 'user.name', 'ratchet');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'ci/\ncoverage/\n');
  git('add', '.');
  git('commit', '-qm', 'seed');
  fs.mkdirSync(path.join(cwd, 'ci'));
  const artifact = path.join(cwd, 'ci', 'coverage-final.json');
  fs.writeFileSync(artifact, '{"src/a.js":{}}\n');
  return { cwd, git, artifact, head: git('rev-parse', 'HEAD') };
}

const adopt = (r, extra = {}) =>
  adoptArtifact({
    cwd: r.cwd,
    quality: QUALITY,
    artifact: r.artifact,
    head: r.head,
    scope: 'affected',
    base: 'origin/main',
    ...extra,
  });

describe('coverage-ratchet — adopt refusals (AC-6)', () => {
  it('refuses a --head that is not the checked-out HEAD', () => {
    const r = repo();
    assert.match(
      adopt(r, { head: 'f'.repeat(40) }),
      /not the checked-out HEAD/,
    );
    assert.equal(fs.existsSync(path.join(r.cwd, COVERAGE_PATH)), false);
  });

  it('refuses a dirty tracked tree', () => {
    const r = repo();
    fs.writeFileSync(path.join(r.cwd, 'src', 'a.js'), 'export const a = 2;\n');
    assert.match(adopt(r), /tracked files are dirty/);
  });

  it('refuses a missing or unparseable artifact', () => {
    const r = repo();
    fs.writeFileSync(r.artifact, 'not json');
    assert.match(adopt(r), /cannot be read as JSON/);
    assert.match(
      adopt(r, { artifact: path.join(r.cwd, 'ci', 'absent.json') }),
      /cannot be read as JSON/,
    );
  });

  it('the CLI exits 1 on a foreign head, naming it', () => {
    const r = repo();
    const res = spawnSync(
      process.execPath,
      [CLI, '--artifact', r.artifact, '--head', 'f'.repeat(40), '--adopt-only'],
      { cwd: r.cwd, encoding: 'utf8' },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr + res.stdout, /not the checked-out HEAD/);
  });
});

describe('coverage-ratchet — adopted artifact seats CRAP rows (AC-7)', () => {
  it('stamps the artifact fresh at HEAD; --seat-missing seats new rows only', async () => {
    const r = repo();
    assert.equal(adopt(r), null);
    const stamp = JSON.parse(
      fs.readFileSync(captureStampPath(r.cwd, COVERAGE_PATH), 'utf8'),
    );
    assert.equal(stamp.commit, r.head);
    assert.equal(stamp.scope, 'affected');
    const probe = {
      cwd: r.cwd,
      coveragePath: COVERAGE_PATH,
      targetDirs: ['src'],
    };
    assert.equal(
      isCoverageFresh({ ...probe, requireScope: 'affected' }).fresh,
      true,
    );

    // Under baselines/, which the tree digest leaves out, as a real seat writes.
    fs.mkdirSync(path.join(r.cwd, 'baselines'));
    const writePath = path.join(r.cwd, 'baselines', 'crap.json');
    const prior = [{ path: 'src/a.js', method: 'a', startLine: 1, crap: 1 }];
    writeEnvelopeFile(writePath, writeEnvelope({ kind: 'crap', rows: prior }));
    const before = loadFile(writePath, { kind: 'crap' });
    const options = resolveCrapUpdaterOptions(
      { seatMissing: true },
      {
        crap: { targetDirs: ['src'], coveragePath: COVERAGE_PATH },
        baselines: { crap: { path: 'baselines/crap.json' } },
      },
      r.cwd,
    );
    const score = buildCrapSeatScorer(options, {
      cwd: r.cwd,
      loadCoverage: (abs) => JSON.parse(fs.readFileSync(abs, 'utf8')),
      scan: async ({ coverage }) => {
        assert.deepEqual(Object.keys(coverage), ['src/a.js']);
        return {
          rows: [
            { file: 'src/a.js', method: 'a', startLine: 1, crap: 9 },
            { file: 'src/a.js', method: 'added', startLine: 5, crap: 2 },
          ],
          scannedFiles: 1,
          resolution: { resolvedMethods: 2, joinableMethods: 2, rate: 1 },
        };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    const result = await seatMissingBaseline({
      kind: 'crap',
      writePath,
      baseRef: 'origin/main',
      gitDiff: async () => ['src/a.js'],
      score,
    });
    assert.equal(result.seated, 1);
    const after = loadFile(writePath, { kind: 'crap' });
    assert.deepEqual(
      after.rows.filter((row) => row.method === 'a'),
      before.rows,
    );
  });

  it('a full-scope adopt writes an unscoped stamp the full probe accepts', () => {
    const r = repo();
    assert.equal(adopt(r, { scope: 'full' }), null);
    const probe = {
      cwd: r.cwd,
      coveragePath: COVERAGE_PATH,
      targetDirs: ['src'],
    };
    assert.equal(isCoverageFresh(probe).fresh, true);
  });
});

describe('coverage-ratchet — the value ratchet (AC-8)', () => {
  const steps = ratchetSteps('/scripts', 'origin/main');

  it('runs the coverage refresh, the CRAP preview and the baselines gate in order', () => {
    assert.deepEqual(
      steps.map((s) => s.step),
      ['update-coverage-baseline', 'quality-preview-crap', 'check-baselines'],
    );
    assert.deepEqual(steps[0].args.slice(1), ['--diff-scope', 'origin/main']);
    assert.ok(steps[1].args.includes('--changed-since'));
    assert.deepEqual(steps[2].env, { BASELINE_REF: 'origin/main' });
    assert.ok(steps[2].args.includes('coverage,crap'));
  });

  it('stops at the first regression and names its step', async () => {
    const ran = [];
    const outcome = await scoreRatchet(steps, (args) => {
      ran.push(path.basename(args[0]));
      return args[0].endsWith('quality-preview.js') ? 1 : 0;
    });
    assert.deepEqual(outcome, {
      failedStep: 'quality-preview-crap',
      status: 1,
    });
    assert.deepEqual(ran, [
      'update-coverage-baseline.js',
      'quality-preview.js',
    ]);
  });

  it('exits 0 when neither coverage nor CRAP regresses', async () => {
    assert.deepEqual(await scoreRatchet(steps, () => 0), {
      failedStep: null,
      status: 0,
    });
  });
});

// Story #6087 — under `suiteOfRecord: "ci"` a Story with no file under the
// CRAP target dirs still carries the deferral marker, so CI's ratchet runs on
// a diff with no scorable file and must hold.
describe('coverage-ratchet — a diff with no scorable file holds', () => {
  const AGENTRC = {
    project: {
      baseBranch: 'main',
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    delivery: {
      quality: {
        gates: {
          crap: { enabled: true, targetDirs: ['src'] },
          coverage: {
            enabled: true,
            suiteOfRecord: 'ci',
            ciRatchetCheck: 'ratchet',
          },
        },
      },
    },
  };
  const SCRIPTS = path.dirname(CLI);
  /** Istanbul data for `src/a.js` (`export const a = () => 1;`), fully hit. */
  const istanbul = (file) => ({
    [file]: {
      path: file,
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } },
        1: { start: { line: 1, column: 23 }, end: { line: 1, column: 24 } },
      },
      fnMap: {
        0: {
          name: 'a',
          decl: {
            start: { line: 1, column: 17 },
            end: { line: 1, column: 18 },
          },
          loc: { start: { line: 1, column: 17 }, end: { line: 1, column: 24 } },
          line: 1,
        },
      },
      branchMap: {},
      s: { 0: 1, 1: 1 },
      f: { 0: 1 },
      b: {},
    },
  });

  it('exits 0 on a docs-only diff against baselines seated on the base', () => {
    const cwd = fs.realpathSync(makeTempDir('coverage-ratchet-docs-'));
    const git = (...args) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
    const node = (script, ...args) =>
      spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
        cwd,
        encoding: 'utf8',
      });
    git('init', '-q');
    git('config', 'user.email', 'ratchet@test.local');
    git('config', 'user.name', 'ratchet');
    git('config', 'commit.gpgsign', 'false');
    for (const dir of ['src', 'docs', 'ci']) fs.mkdirSync(path.join(cwd, dir));
    fs.writeFileSync(
      path.join(cwd, 'src', 'a.js'),
      'export const a = () => 1;\n',
    );
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'ci/\ncoverage/\ntemp/\n');
    fs.writeFileSync(path.join(cwd, '.agentrc.json'), JSON.stringify(AGENTRC));
    const artifact = path.join(cwd, 'ci', 'coverage-final.json');
    fs.writeFileSync(
      artifact,
      JSON.stringify(istanbul(path.join(cwd, 'src', 'a.js'))),
    );
    git('add', '.');
    git('commit', '-qm', 'seed');
    git('branch', '-M', 'main');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const seat = (...steps) => {
      for (const [script, ...args] of steps) {
        const res = node(script, ...args);
        assert.equal(res.status, 0, `${script}: ${res.stderr}${res.stdout}`);
      }
    };
    seat(
      [
        'coverage-ratchet.js',
        '--artifact',
        artifact,
        '--head',
        git('rev-parse', 'HEAD'),
        '--adopt-only',
      ],
      ['update-coverage-baseline.js', '--full-scope'],
      ['update-crap-baseline.js'],
    );
    git('add', 'baselines');
    git('commit', '-qm', 'baselines');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'story');
    fs.writeFileSync(path.join(cwd, 'docs', 'notes.md'), '# notes\n');
    git('add', 'docs');
    git('commit', '-qm', 'docs only');
    const res = node(
      'coverage-ratchet.js',
      '--artifact',
      artifact,
      '--head',
      git('rev-parse', 'HEAD'),
    );
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.doesNotMatch(res.stderr + res.stdout, /produced no baseline rows/);
  });
});

describe('coverage-ratchet — arguments', () => {
  it('defaults to affected scope and requires --artifact and --head', () => {
    const args = parseRatchetArgs(['--artifact', 'a.json', '--head', 'abc']);
    assert.equal(args.scope, 'affected');
    assert.equal(args.error, undefined);
    assert.match(parseRatchetArgs([]).error, /required/);
    assert.match(
      parseRatchetArgs(['--artifact', 'a', '--head', 'b', '--scope', 'x'])
        .error,
      /--scope/,
    );
    assert.equal(parseRatchetArgs(['--adopt-only']).adoptOnly, true);
  });
});
