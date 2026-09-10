/**
 * quality-bootstrap — Story #1401 (Epic #1386)
 *
 * Drives `applyQualityBootstrap` against a tmp project tree to assert the
 * four artefacts the stabilized-gates Epic ships:
 *
 *   1. The `code-quality-guardrails.md` helper lands under
 *      `.agents/workflows/helpers/`.
 *   2. `.husky/pre-commit` carries the `quality:preview` invocation, and a
 *      pre-existing custom hook is preserved with a `custom-hook-skip`
 *      outcome.
 *   3. `quality:preview` and `quality:watch` npm scripts are registered
 *      idempotently in `package.json`.
 *   4. `agentSettings.quality.codingGuardrails` and `autoRefresh` defaults
 *      are seeded into `.agentrc.json` without clobbering existing values.
 *
 * Each scenario exercises the re-run path so the workflow's idempotence
 * guarantee is enforced by the test suite, not just prose.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureBaselineMergeDriver } from '../../.agents/scripts/lib/bootstrap/baseline-merge-driver.js';
import {
  applyQualityBootstrap,
  DOWNSTREAM_PRE_COMMIT,
  ensureGuardrailsHelper,
  ensurePreCommitHook,
  ensureQualityConfigDefaults,
  ensureQualityNpmScripts,
  PRE_COMMIT_MARKER,
  QUALITY_NPM_SCRIPTS,
} from '../../.agents/scripts/lib/bootstrap/quality-bootstrap.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
// `mandrel sync` is the consumer-side install site for the driver's per-clone
// half, so its wiring belongs with the driver's own bootstrap tests rather
// than with the sync command's copy/prune contract.
import { runSync } from '../../lib/cli/sync.js';

let tmpRoot;
let frameworkRoot;

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

beforeEach(() => {
  tmpRoot = makeTempDir('quality-bootstrap-');
  // Stand up a minimal "framework" tree so the helper has a copy source.
  // Real-world callers pass the path to their materialized `.agents/` checkout.
  frameworkRoot = path.join(tmpRoot, '_framework');
  const helperSource = path.join(
    frameworkRoot,
    'workflows',
    'helpers',
    'code-quality-guardrails.md',
  );
  fs.mkdirSync(path.dirname(helperSource), { recursive: true });
  fs.writeFileSync(helperSource, '# Code Quality Guardrails — fixture\n');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeProject(overrides = {}) {
  const root = path.join(tmpRoot, 'project');
  fs.mkdirSync(root, { recursive: true });
  if (overrides.packageJson !== false) {
    writeJson(
      path.join(root, 'package.json'),
      overrides.packageJson ?? {
        name: 'tmp-project',
        version: '0.0.0',
        type: 'module',
        scripts: { test: 'echo ok' },
      },
    );
  }
  if (overrides.agentrc !== false) {
    writeJson(
      path.join(root, '.agentrc.json'),
      overrides.agentrc ?? {
        agentSettings: { baseBranch: 'main' },
      },
    );
  }
  return root;
}

describe('quality-bootstrap — fresh tmp project', () => {
  it('installs helper/hook/scripts but skips default-equal config seeds (Story #2281)', () => {
    const projectRoot = makeProject();

    // First run: helper / hook / scripts mutate. The config step is a
    // no-change because every key the seed would write equals the
    // framework default — the runtime layers those at read time.
    const first = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(first.helper.action, 'copied');
    assert.equal(first.hook.action, 'created');
    assert.equal(first.scripts.action, 'updated');
    assert.equal(first.config.action, 'no-change');
    // Every quality leaf is reported under skippedKeys so callers can
    // surface why the seed was a no-op.
    const skipped = first.config.skippedKeys ?? [];
    assert.ok(skipped.some((k) => k.endsWith('cyclomaticFlag')));
    assert.ok(skipped.some((k) => k.endsWith('autoRefresh.enabled')));

    // Helper landed where the bootstrap step says it should.
    assert.ok(
      fs.existsSync(
        path.join(
          projectRoot,
          '.agents',
          'workflows',
          'helpers',
          'code-quality-guardrails.md',
        ),
      ),
    );

    // Hook carries the quality-preview invocation verbatim.
    const hookBody = fs.readFileSync(
      path.join(projectRoot, '.husky', 'pre-commit'),
      'utf8',
    );
    assert.ok(hookBody.includes(PRE_COMMIT_MARKER));
    assert.equal(hookBody, DOWNSTREAM_PRE_COMMIT);

    // Both npm scripts present with their framework-default values.
    const pkg = readJson(path.join(projectRoot, 'package.json'));
    for (const [name, cmd] of Object.entries(QUALITY_NPM_SCRIPTS)) {
      assert.equal(pkg.scripts[name], cmd);
    }
    // Pre-existing scripts preserved.
    assert.equal(pkg.scripts.test, 'echo ok');

    // The on-disk config is left at the minimum that validates — no
    // empty `delivery.quality.*` scaffolding has been written.
    const cfg = readJson(path.join(projectRoot, '.agentrc.json'));
    assert.ok(
      cfg.delivery === undefined ||
        cfg.delivery.quality === undefined ||
        Object.keys(cfg.delivery.quality).length === 0,
      'default-equal seeds must not materialise as on-disk keys',
    );

    // Second run: every step short-circuits.
    const second = applyQualityBootstrap({ projectRoot, frameworkRoot });
    assert.equal(second.helper.action, 'already-present');
    assert.equal(second.hook.action, 'already-present');
    assert.equal(second.scripts.action, 'no-change');
    assert.equal(second.config.action, 'no-change');
  });
});

describe('quality-bootstrap — preserves operator overrides', () => {
  it('does not clobber a custom .husky/pre-commit hook', () => {
    const projectRoot = makeProject();
    const hookPath = path.join(projectRoot, '.husky', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const customBody = '#!/usr/bin/env sh\nnpm run my-custom-check\n';
    fs.writeFileSync(hookPath, customBody);

    const result = ensurePreCommitHook({ projectRoot });
    assert.equal(result.action, 'custom-hook-skip');
    assert.match(result.notice, /Custom \.husky\/pre-commit detected/);
    // The custom hook is left exactly as the operator wrote it.
    assert.equal(fs.readFileSync(hookPath, 'utf8'), customBody);
    // The notice carries the snippet the operator should merge in by hand.
    assert.ok(result.snippet.includes(PRE_COMMIT_MARKER));
  });

  it('preserves existing npm script values and only fills missing keys', () => {
    const projectRoot = makeProject({
      packageJson: {
        name: 'tmp-project',
        version: '0.0.0',
        type: 'module',
        scripts: {
          'quality:preview': 'node my-custom-preview.js',
          test: 'echo ok',
        },
      },
    });

    const result = ensureQualityNpmScripts({ projectRoot });
    assert.equal(result.action, 'updated');
    assert.equal(result.scripts['quality:preview'], 'already-present');
    assert.equal(result.scripts['quality:watch'], 'added');

    const pkg = readJson(path.join(projectRoot, 'package.json'));
    assert.equal(pkg.scripts['quality:preview'], 'node my-custom-preview.js');
    assert.equal(
      pkg.scripts['quality:watch'],
      QUALITY_NPM_SCRIPTS['quality:watch'],
    );
  });

  it('preserves operator overrides and does NOT seed default-equal siblings (Story #2281)', () => {
    const projectRoot = makeProject({
      agentrc: {
        // Post-reshape: quality lives under `delivery.quality.*`.
        project: { baseBranch: 'main' },
        delivery: {
          quality: {
            codingGuardrails: { cyclomaticFlag: 6 },
            // autoRefresh entirely absent. Under the Story #2281
            // contract, absent keys whose intended value equals the
            // framework default are NOT seeded — the runtime layers
            // defaults at read time.
          },
        },
      },
    });

    const result = ensureQualityConfigDefaults({ projectRoot });
    assert.equal(result.action, 'no-change');
    // Custom override survives.
    const cfg = readJson(path.join(projectRoot, '.agentrc.json'));
    assert.equal(cfg.delivery.quality.codingGuardrails.cyclomaticFlag, 6);
    // Default-equal siblings were NOT seeded; the runtime resolves them
    // at read time.
    assert.equal(
      cfg.delivery.quality.codingGuardrails.cyclomaticMustFix,
      undefined,
    );
    assert.equal(cfg.delivery.quality.autoRefresh, undefined);
    // Default-equal writes are reported under skippedKeys.
    assert.ok(
      result.skippedKeys.some((k) => k.endsWith('cyclomaticMustFix')),
      'cyclomaticMustFix should be reported as skipped (matches framework default)',
    );
    assert.ok(
      result.skippedKeys.some((k) => k.endsWith('autoRefresh.enabled')),
      'autoRefresh.enabled should be reported as skipped (matches framework default)',
    );
    // addedKeys stays empty because every would-be write is default-equal.
    assert.deepEqual(result.addedKeys, []);
  });
});

describe('quality-bootstrap — degraded environments', () => {
  it('reports missing-source when the helper file is absent', () => {
    const projectRoot = makeProject();
    const emptyFramework = path.join(tmpRoot, '_empty-framework');
    fs.mkdirSync(emptyFramework, { recursive: true });
    const result = ensureGuardrailsHelper({
      projectRoot,
      frameworkRoot: emptyFramework,
    });
    assert.equal(result.action, 'missing-source');
  });

  it('reports missing-package-json when package.json is absent', () => {
    const projectRoot = makeProject({ packageJson: false });
    const result = ensureQualityNpmScripts({ projectRoot });
    assert.equal(result.action, 'missing-package-json');
  });

  it('reports missing-config when .agentrc.json is absent', () => {
    const projectRoot = makeProject({ agentrc: false });
    const result = ensureQualityConfigDefaults({ projectRoot });
    assert.equal(result.action, 'missing-config');
    assert.deepEqual(result.addedKeys, []);
  });
});

describe('quality-bootstrap — baselines merge driver (AC-6)', () => {
  // Asserted as a literal, not imported: this string is the contract a
  // consumer's `.gitattributes` must end up carrying, so the test should
  // fail if the installer changes it.
  const BASELINE_MERGE_ATTRIBUTE = 'baselines/*.json merge=mandrel-baseline';

  // The git half is stubbed everywhere here: these assertions are about the
  // tracked `.gitattributes` line, and a real `git config` would write into
  // whatever repo the suite happens to run inside.
  const noGit = () => ({ status: 1, stdout: '', stderr: '' });

  const PRE_EXISTING = [
    '* text=auto eol=lf',
    '*.png binary',
    'docs/** linguist-documentation',
  ].join('\n');

  it('creates a .gitattributes carrying only the attribute line', () => {
    const projectRoot = makeProject();
    const result = ensureBaselineMergeDriver({ projectRoot, spawnImpl: noGit });

    assert.equal(result.attributes, 'created');
    assert.equal(
      fs.readFileSync(path.join(projectRoot, '.gitattributes'), 'utf8'),
      `${BASELINE_MERGE_ATTRIBUTE}\n`,
    );
  });

  it('appends to an existing file, leaving every prior line untouched', () => {
    const projectRoot = makeProject();
    const target = path.join(projectRoot, '.gitattributes');
    fs.writeFileSync(target, `${PRE_EXISTING}\n`);

    const result = ensureBaselineMergeDriver({ projectRoot, spawnImpl: noGit });
    assert.equal(result.attributes, 'appended');

    const lines = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines.slice(0, 3), PRE_EXISTING.split('\n'));
    assert.equal(
      lines.filter((l) => l === BASELINE_MERGE_ATTRIBUTE).length,
      1,
      'the attribute line appears exactly once',
    );
  });

  it('is idempotent — a second run reports already-present and changes no bytes', () => {
    const projectRoot = makeProject();
    const target = path.join(projectRoot, '.gitattributes');
    fs.writeFileSync(target, `${PRE_EXISTING}\n`);

    ensureBaselineMergeDriver({ projectRoot, spawnImpl: noGit });
    const afterFirst = fs.readFileSync(target);

    const second = ensureBaselineMergeDriver({ projectRoot, spawnImpl: noGit });
    assert.equal(second.action, 'already-present');
    assert.equal(second.attributes, 'already-present');
    assert.ok(fs.readFileSync(target).equals(afterFirst));
  });

  it('does not glue its line onto a file with no trailing newline', () => {
    const projectRoot = makeProject();
    const target = path.join(projectRoot, '.gitattributes');
    fs.writeFileSync(target, '*.png binary'); // no trailing \n
    ensureBaselineMergeDriver({ projectRoot, spawnImpl: noGit });
    const lines = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, ['*.png binary', BASELINE_MERGE_ATTRIBUTE]);
  });

  it('ignores a commented-out registration', () => {
    const projectRoot = makeProject();
    const target = path.join(projectRoot, '.gitattributes');
    fs.writeFileSync(target, `# ${BASELINE_MERGE_ATTRIBUTE}\n`);
    const result = ensureBaselineMergeDriver({ projectRoot, spawnImpl: noGit });
    assert.equal(result.attributes, 'appended');
  });

  it('registers the per-clone driver config inside a git repo', () => {
    const projectRoot = makeProject();
    const calls = [];
    const spawnImpl = (_cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { status: 0, stdout: '.git' };
      if (args.includes('--get')) return { status: 1, stdout: '' };
      return { status: 0, stdout: '' };
    };
    const result = ensureBaselineMergeDriver({ projectRoot, spawnImpl });
    assert.equal(result.config, 'set');
    assert.ok(
      calls.some((c) => c.includes('merge.mandrel-baseline.driver')),
      'sets the driver command for this clone',
    );
  });

  it('reports not-a-repo rather than failing outside a git repository', () => {
    const projectRoot = makeProject();
    const result = ensureBaselineMergeDriver({ projectRoot, spawnImpl: noGit });
    assert.equal(result.config, 'not-a-repo');
  });

  it('is wired into applyQualityBootstrap', () => {
    const projectRoot = makeProject();
    const result = applyQualityBootstrap({
      projectRoot,
      frameworkRoot,
      spawnImpl: noGit,
    });
    assert.ok(result.mergeDriver, 'the merge-driver step reports an outcome');
    assert.equal(result.mergeDriver.attributes, 'created');
  });
});

describe('baselines merge driver — installed wherever base-sync runs (Story #5277, AC-1)', () => {
  const BASELINE_MERGE_ATTRIBUTE = 'baselines/*.json merge=mandrel-baseline';

  /** Record every `git config` write a run performs. */
  function repoSpawn({ existing = null } = {}) {
    const writes = [];
    const spawnImpl = (_cmd, args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: '.git' };
      if (args.includes('--get')) {
        return existing === null
          ? { status: 1, stdout: '' }
          : { status: 0, stdout: `${existing}\n` };
      }
      writes.push(args);
      return { status: 0, stdout: '' };
    };
    spawnImpl.writes = writes;
    return spawnImpl;
  }

  /** The value written to `merge.mandrel-baseline.driver`, or undefined. */
  function driverValue(spawnImpl) {
    return spawnImpl.writes.find(
      (args) => args[2] === 'merge.mandrel-baseline.driver',
    )?.[3];
  }

  it('installs a command whose first token is an absolute path to node', () => {
    // Git runs a merge driver through a shell whose PATH is whatever launched
    // git — a GUI client, a Finder-launched editor, launchd. A bare `node`
    // there is not found, the driver never starts, and git silently falls back
    // to the text merge the driver exists to replace.
    const projectRoot = makeProject();
    const spawnImpl = repoSpawn();
    ensureBaselineMergeDriver({ projectRoot, spawnImpl });

    const command = driverValue(spawnImpl);
    const [firstToken] = command.match(/"[^"]*"|\S+/g);
    const nodePath = firstToken.replace(/^"|"$/g, '');
    assert.ok(path.isAbsolute(nodePath), `${nodePath} is not an absolute path`);
    assert.equal(nodePath, process.execPath);
    // Quoted, so an installation under a path with a space still starts.
    assert.equal(firstToken, `"${process.execPath}"`);
    assert.match(command, /\.agents\/scripts\/merge-baseline\.js %O %A %B %P$/);
  });

  it('rewrites a stale relative-node command left by an earlier install', () => {
    const projectRoot = makeProject();
    const spawnImpl = repoSpawn({
      existing: 'node .agents/scripts/merge-baseline.js %O %A %B %P',
    });
    const result = ensureBaselineMergeDriver({ projectRoot, spawnImpl });
    assert.equal(result.config, 'set');
    assert.match(driverValue(spawnImpl), /^"/);
  });

  describe('configOnly — the half a consumer sync may install', () => {
    it('writes the config key when .gitattributes already declares the attribute', () => {
      const projectRoot = makeProject();
      fs.writeFileSync(
        path.join(projectRoot, '.gitattributes'),
        `${BASELINE_MERGE_ATTRIBUTE}\n`,
      );
      const spawnImpl = repoSpawn();
      const result = ensureBaselineMergeDriver({
        projectRoot,
        configOnly: true,
        spawnImpl,
      });
      assert.equal(result.action, 'updated');
      assert.equal(result.config, 'set');
      assert.ok(driverValue(spawnImpl));
    });

    it('creates no .gitattributes in a project that never opted in', () => {
      // `mandrel sync` materializes `.agents/`; it is not an opt-in to the
      // quality surface, so it must not start routing a consumer's files
      // through a merge driver they never asked for.
      const projectRoot = makeProject();
      const spawnImpl = repoSpawn();
      const result = ensureBaselineMergeDriver({
        projectRoot,
        configOnly: true,
        spawnImpl,
      });
      assert.equal(result.action, 'skipped');
      assert.equal(result.config, 'skipped');
      assert.equal(
        fs.existsSync(path.join(projectRoot, '.gitattributes')),
        false,
      );
      assert.deepEqual(spawnImpl.writes, []);
    });
  });

  it('this repo installs it from `prepare`, so `npm install` completes it', () => {
    // The half that cannot ship with the repository is installed by the one
    // command every contributor runs. Asserting the wiring rather than the
    // effect: running `npm install` inside a test would rewrite the config of
    // whatever repository the suite happens to execute in.
    // `new URL(...).pathname` is a URL path, not a filesystem path: on Windows
    // it reads `/D:/a/mandrel/...`, and resolving that yields `D:\D:\a\...`.
    // `fileURLToPath` is the only spelling that round-trips on both platforms.
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../..',
    );
    const pkg = readJson(path.join(repoRoot, 'package.json'));
    assert.match(pkg.scripts.prepare, /baselines:merge-driver/);
    assert.equal(
      pkg.scripts['baselines:merge-driver'],
      'node .agents/scripts/merge-baseline.js --install',
    );
  });

  it('mandrel sync installs the same key in a consumer checkout', () => {
    // The config half is per-clone and therefore absent in every fresh clone,
    // while the attribute half is tracked and always present — so the half
    // that cannot travel is installed by the one command every consumer runs.
    // Driven through `runSync` itself rather than its seam's default, so the
    // wiring is what is proven.
    const consumerRoot = path.join(tmpRoot, 'consumer');
    const packageRoot = path.join(tmpRoot, 'pkg');
    fs.mkdirSync(path.join(packageRoot, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, '.agents', 'x.md'), 'x\n');
    writeJson(path.join(packageRoot, 'package.json'), { version: '9.9.9' });
    fs.mkdirSync(consumerRoot, { recursive: true });
    fs.writeFileSync(
      path.join(consumerRoot, '.gitattributes'),
      `${BASELINE_MERGE_ATTRIBUTE}\n`,
    );

    const seen = [];
    runSync({
      argv: [],
      resolvePackageRoot: () => packageRoot,
      cwd: () => consumerRoot,
      write: () => {},
      writeErr: () => {},
      exit: () => {},
      ensureMergeDriver: (ctx) => {
        seen.push(ctx);
        return ensureBaselineMergeDriver({ ...ctx, spawnImpl: repoSpawn() });
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].projectRoot, consumerRoot);
    assert.equal(seen[0].configOnly, true, 'sync never writes .gitattributes');
  });
});
