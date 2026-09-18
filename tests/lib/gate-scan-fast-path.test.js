/**
 * tests/lib/gate-scan-fast-path.test.js — the fast paths Story #5109 added to
 * the gate-scan pipeline, each pinned by the invariant that made it safe.
 *
 * Every optimisation here is a *cost* change, so each test asserts the
 * unchanged **result** rather than the improved number: a benchmark rots the
 * day the runner changes, whereas "the fast path and the slow path agree" is
 * true forever and is the only thing that makes the fast path admissible.
 *
 *   1. `resolveTsTranspilerVersion()` reads the manifest — same string, and
 *      the 9 MB compiler is provably not evaluated.
 *   2. The precompiled `ignoreGlobs` matcher answers exactly what the
 *      functional `minimatch()` call it replaced answered, over this
 *      repository's real configured patterns and real tree.
 *   3. In-process and pooled scoring produce identical MI scores, which is
 *      what lets `POOL_SERIAL_THRESHOLD` be retuned at all.
 *   4. The diff-scoped cyclomatic scan reports the same rows the whole-tree
 *      scan reports for every file it scores, and keeps `scannedFiles`
 *      reporting the whole walk.
 *   5. The committed AJV validator and a live compile return the same verdict
 *      and the same errors.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { minimatch } from 'minimatch';
import {
  getQuality,
  resolveConfig,
} from '../../.agents/scripts/lib/config-resolver.js';
import { getAgentrcValidator } from '../../.agents/scripts/lib/config-settings-schema.js';
import { runOnPool } from '../../.agents/scripts/lib/cpu-pool.js';
import {
  resolveCyclomaticPolicy,
  scanCyclomatic,
} from '../../.agents/scripts/lib/cyclomatic-ceiling.js';
import { resolveDependencyVersion } from '../../.agents/scripts/lib/dependency-version.js';
import {
  calculateAll,
  isIgnoredByGlobs,
  scanDirectory,
} from '../../.agents/scripts/lib/maintainability-utils.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { resolveTsTranspilerVersion } from '../../.agents/scripts/lib/transpile.js';
import {
  GENERATED_VALIDATOR_PATH,
  runCli as runGeneratedValidatorCli,
} from '../../scripts/check-generated-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TRANSPILE_URL = pathToFileURL(
  path.join(REPO_ROOT, '.agents/scripts/lib/transpile.js'),
).href;
// A `URL` instance, not its href: `new Worker(string)` rejects a `file://`
// string outright and only accepts a path or a URL object.
const MI_WORKER_URL = pathToFileURL(
  path.join(REPO_ROOT, '.agents/scripts/lib/workers/maintainability-worker.js'),
);

/** The maintainability gate's resolved scope — the real one, not a fixture. */
function realMaintainabilityScope() {
  const quality = getQuality(resolveConfig({ cwd: REPO_ROOT }));
  const mi = quality.maintainability;
  return {
    targetDirs: mi.targetDirs ?? [],
    ignoreGlobs: mi.ignoreGlobs ?? [],
  };
}

/** Every scorable source file under the gate's target dirs, ignore-globs off. */
function allScopedFiles(targetDirs) {
  const files = [];
  for (const dir of targetDirs) {
    scanDirectory(path.resolve(REPO_ROOT, dir), files, {
      cwd: REPO_ROOT,
      ignoreGlobs: [],
    });
  }
  return files;
}

describe('lazy TypeScript — the version stamp costs no compiler', () => {
  it('reads the same version the installed package manifest declares', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, 'node_modules/typescript/package.json'),
        'utf-8',
      ),
    );
    assert.equal(resolveTsTranspilerVersion(), manifest.version);
  });

  it('does not evaluate typescript, but transpiling a .ts input still does', () => {
    // A child process is the only honest probe: this test file's own process
    // may already have loaded the compiler for some other reason.
    const probe = `
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(TRANSPILE_URL)});
      const mod = await import(${JSON.stringify(TRANSPILE_URL)});
      const version = mod.resolveTsTranspilerVersion();
      const tsPath = require.resolve('typescript');
      const afterVersion = Object.hasOwn(require.cache, tsPath);
      mod.transpileIfNeeded('probe.ts', 'const a: number = 1;');
      const afterTranspile = Object.hasOwn(require.cache, tsPath);
      process.stdout.write(JSON.stringify({ version, afterVersion, afterTranspile }));
    `;
    const run = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', probe],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
    const out = JSON.parse(run.stdout);
    assert.match(out.version, /^\d+\.\d+\.\d+/);
    assert.equal(
      out.afterVersion,
      false,
      'resolveTsTranspilerVersion must not evaluate the compiler',
    );
    assert.equal(
      out.afterTranspile,
      true,
      'transpiling a .ts input must still load the compiler',
    );
  });
});

describe('precompiled ignore globs — same verdicts as functional minimatch', () => {
  it('agrees with minimatch() on every file the real gate scope walks', () => {
    const { targetDirs, ignoreGlobs } = realMaintainabilityScope();
    assert.ok(
      ignoreGlobs.length > 0,
      'this repository must configure ignoreGlobs for the comparison to mean anything',
    );
    const files = allScopedFiles(targetDirs);
    assert.ok(files.length > 100, `expected a real tree, got ${files.length}`);

    let ignored = 0;
    let compared = 0;
    for (const abs of files) {
      const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
      // The functional call this replaced, reproduced verbatim.
      const functional = ignoreGlobs.some((g) =>
        minimatch(rel, g, { dot: true }),
      );
      const compiled = isIgnoredByGlobs(abs, ignoreGlobs, REPO_ROOT);
      assert.equal(compiled, functional, `verdict diverged for ${rel}`);
      compared += 1;
      if (compiled) ignored += 1;
    }
    assert.equal(compared, files.length);
    assert.ok(ignored > 0, 'the real ignoreGlobs must ignore something');
  });

  it('memoises per path without leaking a verdict between pattern lists', () => {
    const target = '.agents/scripts/lib/generated/agentrc-validator.js';
    const withPattern = ['.agents/scripts/lib/generated/**'];
    const withoutPattern = ['.agents/scripts/nothing-matches-this/**'];
    // Ask twice per list, interleaved: a memo keyed on the path alone (rather
    // than on the path *and* the pattern list) would answer the second list
    // with the first list's verdict.
    assert.equal(isIgnoredByGlobs(target, withPattern, REPO_ROOT), true);
    assert.equal(isIgnoredByGlobs(target, withoutPattern, REPO_ROOT), false);
    assert.equal(isIgnoredByGlobs(target, withPattern, REPO_ROOT), true);
    assert.equal(isIgnoredByGlobs(target, withoutPattern, REPO_ROOT), false);
  });
});

describe('in-process vs pooled scoring — identical output', () => {
  it('scores a batch to the same MI values on either path', async () => {
    const { targetDirs } = realMaintainabilityScope();
    // Below POOL_SERIAL_THRESHOLD, so calculateAll takes the in-process path.
    const batch = allScopedFiles(targetDirs).slice(0, 24);
    assert.equal(batch.length, 24);

    const serial = await calculateAll(batch);
    const pooled = await runOnPool(MI_WORKER_URL, batch, { concurrency: 2 });

    batch.forEach((abs, i) => {
      const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/');
      assert.equal(
        serial[rel],
        pooled[i]?.score,
        `serial and pooled disagreed on ${rel}`,
      );
    });
  });
});

describe('diff-scoped cyclomatic scan', () => {
  const { targetDirs, ignoreGlobs } = realMaintainabilityScope();
  const ceiling = resolveCyclomaticPolicy(
    getQuality(resolveConfig({ cwd: REPO_ROOT })),
  ).mustFix;
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'baselines/cyclomatic.json'), 'utf-8'),
  );

  it('reproduces the baseline rows while scoring only the scoped files', () => {
    const scopeFiles = new Set(baseline.rows.map((r) => r.file));
    const scoped = scanCyclomatic({
      targetDirs,
      ignoreGlobs,
      ceiling,
      cwd: REPO_ROOT,
      scopeFiles,
    });

    // `scannedFiles` still reports the whole walk — the scan surface did not
    // shrink, only the scoring did.
    assert.ok(
      scoped.scannedFiles > scoped.scoredFiles,
      `expected the walk (${scoped.scannedFiles}) to exceed the scored set (${scoped.scoredFiles})`,
    );
    assert.equal(scoped.scoredFiles, scopeFiles.size);
    assert.equal(scoped.parseErrors, 0);

    // Every recorded breach is re-derived exactly, which is what keeps
    // `improved` / `worsened` / `removed` detectable under the narrow scope.
    assert.deepEqual(scoped.rows, baseline.rows);
  });

  it('scores nothing when the scope is empty, and still reports the walk', () => {
    const empty = scanCyclomatic({
      targetDirs,
      ignoreGlobs,
      ceiling,
      cwd: REPO_ROOT,
      scopeFiles: new Set(),
    });
    assert.equal(empty.scoredFiles, 0);
    assert.deepEqual(empty.rows, []);
    assert.ok(empty.scannedFiles > 0);
  });
});

describe('precompiled .agentrc validator', () => {
  it('is in step with AGENTRC_SCHEMA', () => {
    const out = [];
    const err = [];
    const code = runGeneratedValidatorCli({
      argv: ['--check'],
      cwd: REPO_ROOT,
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
    });
    assert.equal(
      code,
      0,
      `committed validator is stale — run \`npm run validator:gen\`:\n${err.join('')}`,
    );
  });

  it('--check fails when the committed artifact drifts from the schema', () => {
    const out = [];
    const err = [];
    const code = runGeneratedValidatorCli({
      argv: ['--check'],
      cwd: REPO_ROOT,
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      // Stand in for "the schema constant was edited without regenerating":
      // the fresh emit no longer matches the bytes on disk.
      generateImpl: () => '// a schema edit that was never regenerated\n',
    });
    assert.equal(code, 1);
    assert.match(err.join(''), /stale against AGENTRC_SCHEMA/);
    assert.match(err.join(''), /npm run validator:gen/);
  });

  it('returns the same verdict and errors as a live AJV compile', () => {
    const generated = getAgentrcValidator();
    const spawnProbe = (config) => {
      const probe = `
        process.env.MANDREL_AGENTRC_VALIDATOR = 'dynamic';
        const { getAgentrcValidator } = await import(${JSON.stringify(
          pathToFileURL(
            path.join(
              REPO_ROOT,
              '.agents/scripts/lib/config-settings-schema.js',
            ),
          ).href,
        )});
        const validate = getAgentrcValidator();
        const ok = validate(${JSON.stringify(config)});
        process.stdout.write(JSON.stringify({ ok, errors: validate.errors ?? null }));
      `;
      const run = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', probe],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      assert.equal(run.status, 0, `dynamic probe failed: ${run.stderr}`);
      return JSON.parse(run.stdout);
    };

    const cases = [
      JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, '.agentrc.json'), 'utf-8'),
      ),
      { project: {}, unknownTopLevelKey: 1 },
      { github: { owner: 'x' } },
    ];
    for (const config of cases) {
      const ok = generated(config);
      const dynamic = spawnProbe(config);
      assert.equal(
        ok,
        dynamic.ok,
        `verdict diverged for ${JSON.stringify(config)}`,
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(generated.errors ?? null)),
        dynamic.errors,
        `errors diverged for ${JSON.stringify(config)}`,
      );
    }
  });
});

describe('dependency-version — manifest resolution without loading', () => {
  const realRequire = createRequire(import.meta.url);

  it('reads a real installed package version through the subpath resolver', () => {
    assert.equal(
      resolveDependencyVersion('typescript', realRequire),
      JSON.parse(
        fs.readFileSync(
          path.join(REPO_ROOT, 'node_modules/typescript/package.json'),
          'utf-8',
        ),
      ).version,
    );
  });

  it('walks up from the main entry when the package.json subpath is withheld', () => {
    // A package whose `exports` map does not expose `./package.json` — real,
    // and increasingly common. The fallback resolves the main entry (still
    // without loading it) and walks to the enclosing manifest.
    const stub = {
      resolve: (request) => {
        if (request.endsWith('/package.json')) {
          throw new Error('ERR_PACKAGE_PATH_NOT_EXPORTED');
        }
        return realRequire.resolve(request);
      },
    };
    assert.equal(
      resolveDependencyVersion('typescript', stub),
      resolveDependencyVersion('typescript', realRequire),
    );
  });

  it('returns null when the package cannot be resolved at all', () => {
    const stub = {
      resolve: () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    };
    assert.equal(resolveDependencyVersion('typescript', stub), null);
  });

  it('returns null when the manifest declares no usable version', () => {
    const tmp = makeTempDir('dep_version_');
    try {
      fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"noversion"}');
      const entry = path.join(tmp, 'lib', 'index.js');
      fs.writeFileSync(entry, 'module.exports = {};\n');
      const stub = {
        resolve: (request) => {
          if (request.endsWith('/package.json')) throw new Error('nope');
          return entry;
        },
      };
      assert.equal(resolveDependencyVersion('noversion', stub), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('check-generated-validator — write mode', () => {
  it('writes the emitted source and reports its size', () => {
    const tmp = makeTempDir('gen_validator_');
    try {
      const written = [];
      const out = [];
      const code = runGeneratedValidatorCli({
        argv: [],
        cwd: tmp,
        stdout: { write: (s) => out.push(s) },
        stderr: { write: () => {} },
        generateImpl: () => 'export default 1;\n',
        writeFileImpl: (p, data) => written.push([p, data]),
      });
      assert.equal(code, 0);
      assert.equal(written.length, 1);
      assert.equal(
        written[0][0],
        path.join(tmp, GENERATED_VALIDATOR_PATH),
        'writes to the artifact path under the given cwd',
      );
      assert.equal(written[0][1], 'export default 1;\n');
      assert.match(out.join(''), /wrote 18 bytes/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--check reports a missing artifact distinctly from a stale one', () => {
    const tmp = makeTempDir('gen_validator_missing_');
    try {
      const err = [];
      const code = runGeneratedValidatorCli({
        argv: ['--check'],
        cwd: tmp,
        stdout: { write: () => {} },
        stderr: { write: (s) => err.push(s) },
        generateImpl: () => 'export default 1;\n',
      });
      assert.equal(code, 1);
      assert.match(err.join(''), /is missing/);
      assert.doesNotMatch(err.join(''), /stale/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
