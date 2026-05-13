/**
 * migrate-to-v6.test — integration coverage for the consumer migration CLI.
 *
 * Acceptance (Task #1624):
 *   (a) Running on a v5 fixture leaves it on v6 with no manual residue.
 *   (b) Running twice on the same fixture produces no diff on the second run.
 *   (c) Running on a dirty working tree exits non-zero without `--yes`;
 *       with `--yes`, proceeds.
 *   (d) Tool makes zero network calls.
 *
 * Strategy:
 *   - Use a real-fs temp directory for each test case (deterministic per
 *     test name, cleaned up in `afterEach`). Tests that need a git index
 *     run `git init` + `git add`/`git commit` against the temp dir; we
 *     do not mock `git` because the CLI shells out to `git status` and
 *     the dirty-tree check is what we're validating.
 *   - Network calls are validated by walking the CLI module source for
 *     `fetch(`, `https.`, `http.`, `net.` — there is no other surface
 *     in the script.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkWorkingTree,
  formatSummary,
  parseArgv,
  runMigration,
} from '../../.agents/scripts/migrate-to-v6.js';

/* ------------------------------------------------------------------------- */
/* Fixture helpers                                                           */
/* ------------------------------------------------------------------------- */

const V5_AGENTRC = {
  agentSettings: {
    paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    epicClose: { runRetro: false, skipDocsFreshness: true },
    riskGates: { heuristics: ['destructive-migration', 'auth-change'] },
    sprintClose: { runRetro: true },
  },
  orchestration: {
    provider: 'github',
    hitl: {},
    executor: 'manual',
    runners: {
      epicRunner: {
        enabled: true,
        concurrencyCap: 3,
        idleTimeoutSec: 900,
        pollIntervalSec: 5,
        logsDir: '.agents/runs',
      },
      closeRetry: { maxAttempts: 3, backoffMs: [250, 500, 1000] },
    },
  },
};

const V5_GITMODULES = `[submodule ".agents"]
\tpath = .agents
\turl = https://github.com/dsj1984/agent-protocols.git
\tbranch = main
`;

const V5_PACKAGE_JSON = {
  name: 'consumer-app',
  version: '1.0.0',
  dependencies: {
    'agent-protocols': '^5.41.0',
    chalk: '^5.0.0',
  },
};

/**
 * Create a temp directory, optionally as a git repo, seeded with the
 * three target files. Returns the absolute path; caller cleans up.
 *
 * @param {{ asRepo: boolean; files?: Record<string, string | object>; commit?: boolean }} options
 * @returns {string}
 */
function makeFixtureDir({ asRepo, files = {}, commit = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-v6-'));
  for (const [name, content] of Object.entries(files)) {
    const payload =
      typeof content === 'string'
        ? content
        : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(join(dir, name), payload, 'utf8');
  }
  if (asRepo) {
    const init = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    assert.equal(init.status, 0, `git init failed: ${init.stderr?.toString()}`);
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dir,
    });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    if (commit) {
      spawnSync('git', ['add', '-A'], { cwd: dir });
      const c = spawnSync(
        'git',
        ['commit', '-q', '--no-verify', '-m', 'fixture seed'],
        { cwd: dir },
      );
      assert.equal(c.status, 0, `git commit failed: ${c.stderr?.toString()}`);
    }
  }
  return dir;
}

/** @type {string[]} */
const cleanupDirs = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const d = cleanupDirs.pop();
    if (!d) continue;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort; Windows occasionally holds on to a handle for a tick.
    }
  }
});

function track(dir) {
  cleanupDirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------------- */
/* Acceptance (a): v5 → v6 with no manual residue                            */
/* ------------------------------------------------------------------------- */

describe('migrate-to-v6 — (a) v5 fixture becomes v6 with no manual residue', () => {
  it('rewrites .agentrc.json, .gitmodules, and package.json in one run', () => {
    const dir = track(
      makeFixtureDir({
        asRepo: true,
        commit: true,
        files: {
          '.agentrc.json': V5_AGENTRC,
          '.gitmodules': V5_GITMODULES,
          'package.json': V5_PACKAGE_JSON,
        },
      }),
    );

    const result = runMigration({ cwd: dir });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.ok(
      result.plan.summary.totalChanges > 0,
      'expected at least one change',
    );
    assert.deepEqual(result.written.sort(), [
      '.agentrc.json',
      '.gitmodules',
      'package.json',
    ]);

    // Reload from disk and assert the rewritten shapes.
    const rewrittenAgentrc = JSON.parse(
      readFileSync(join(dir, '.agentrc.json'), 'utf8'),
    );
    assert.equal(rewrittenAgentrc.agentSettings.epicClose, undefined);
    assert.equal(rewrittenAgentrc.agentSettings.riskGates, undefined);
    assert.equal(rewrittenAgentrc.agentSettings.sprintClose, undefined);
    assert.deepEqual(rewrittenAgentrc.agentSettings.planning.riskHeuristics, [
      'destructive-migration',
      'auth-change',
    ]);
    assert.equal(rewrittenAgentrc.orchestration.hitl, undefined);
    assert.equal(rewrittenAgentrc.orchestration.executor, undefined);
    assert.equal(rewrittenAgentrc.orchestration.runners.epicRunner, undefined);
    assert.equal(rewrittenAgentrc.orchestration.runners.closeRetry, undefined);
    const deliver = rewrittenAgentrc.orchestration.runners.deliverRunner;
    assert.ok(deliver, 'expected renamed deliverRunner block');
    assert.equal(deliver.enabled, true);
    assert.equal(deliver.concurrencyCap, 3);
    // idleTimeoutSec / pollIntervalSec / logsDir removed BEFORE block rename.
    assert.equal(deliver.idleTimeoutSec, undefined);
    assert.equal(deliver.pollIntervalSec, undefined);
    assert.equal(deliver.logsDir, undefined);
    const merge = rewrittenAgentrc.orchestration.runners.storyMergeRetry;
    assert.deepEqual(merge, { maxAttempts: 3, backoffMs: [250, 500, 1000] });

    const rewrittenGitmodules = readFileSync(join(dir, '.gitmodules'), 'utf8');
    assert.match(rewrittenGitmodules, /\/mandrel\.git/u);
    assert.doesNotMatch(rewrittenGitmodules, /agent-protocols/u);

    const rewrittenPkg = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    );
    assert.equal(rewrittenPkg.dependencies['agent-protocols'], undefined);
    assert.equal(rewrittenPkg.dependencies.mandrel, '^5.41.0');
    assert.equal(rewrittenPkg.dependencies.chalk, '^5.0.0');
  });

  it('handles a partial consumer that only has .agentrc.json', () => {
    const dir = track(
      makeFixtureDir({
        asRepo: true,
        commit: true,
        files: { '.agentrc.json': V5_AGENTRC },
      }),
    );
    const result = runMigration({ cwd: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.written, ['.agentrc.json']);
  });
});

/* ------------------------------------------------------------------------- */
/* Acceptance (b): idempotency — second run is a no-op                       */
/* ------------------------------------------------------------------------- */

describe('migrate-to-v6 — (b) running twice produces no diff on the second run', () => {
  it('a clean second run reports zero changes', () => {
    const dir = track(
      makeFixtureDir({
        asRepo: true,
        commit: true,
        files: {
          '.agentrc.json': V5_AGENTRC,
          '.gitmodules': V5_GITMODULES,
          'package.json': V5_PACKAGE_JSON,
        },
      }),
    );
    const first = runMigration({ cwd: dir });
    assert.equal(first.ok, true);
    assert.ok(first.plan.summary.totalChanges > 0);

    // After the first migration the tree is dirty (the files just got
    // rewritten). Commit so the second pass exercises a clean tree and
    // we can be sure idempotency isn't masked by the dirty-tree guard.
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync(
      'git',
      ['commit', '-q', '--no-verify', '-m', 'apply v6 migration'],
      { cwd: dir },
    );

    const second = runMigration({ cwd: dir });
    assert.equal(second.ok, true);
    assert.equal(second.plan.summary.totalChanges, 0);
    assert.equal(second.plan.summary.alreadyV6, true);
    assert.deepEqual(second.written, []);

    // Bonus: the bytes on disk match what the second run would have
    // written — i.e. the first pass produced the final v6 shape.
    const onDisk = JSON.parse(readFileSync(join(dir, '.agentrc.json'), 'utf8'));
    const replanned = runMigration({ cwd: dir, dryRun: true });
    assert.deepEqual(replanned.plan.agentrc?.next ?? onDisk, onDisk);
  });

  it('an already-v6 consumer is a no-op on the first run', () => {
    const v6Agentrc = {
      agentSettings: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        planning: { riskHeuristics: ['destructive-migration'] },
      },
      orchestration: {
        provider: 'github',
        runners: {
          deliverRunner: { enabled: true, concurrencyCap: 3 },
          storyMergeRetry: { maxAttempts: 3 },
        },
      },
    };
    const dir = track(
      makeFixtureDir({
        asRepo: true,
        commit: true,
        files: { '.agentrc.json': v6Agentrc },
      }),
    );
    const result = runMigration({ cwd: dir });
    assert.equal(result.ok, true);
    assert.equal(result.plan.summary.alreadyV6, true);
    assert.deepEqual(result.written, []);
  });
});

/* ------------------------------------------------------------------------- */
/* Acceptance (c): dirty-tree refusal without --yes                          */
/* ------------------------------------------------------------------------- */

describe('migrate-to-v6 — (c) dirty working tree behaviour', () => {
  it('refuses to run on a dirty tree without --yes', () => {
    const dir = track(
      makeFixtureDir({
        asRepo: true,
        commit: true,
        files: {
          '.agentrc.json': V5_AGENTRC,
        },
      }),
    );
    // Introduce a working-tree change to make the tree dirty.
    writeFileSync(join(dir, 'README.md'), '# scratch\n', 'utf8');

    const tree = checkWorkingTree(dir);
    assert.equal(tree.isRepo, true);
    assert.equal(tree.dirty, true);

    const result = runMigration({ cwd: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /dirty/iu);
    assert.deepEqual(result.written, []);
  });

  it('proceeds on a dirty tree when --yes is passed', () => {
    const dir = track(
      makeFixtureDir({
        asRepo: true,
        commit: true,
        files: {
          '.agentrc.json': V5_AGENTRC,
        },
      }),
    );
    writeFileSync(join(dir, 'README.md'), '# scratch\n', 'utf8');
    const result = runMigration({ cwd: dir, yes: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.written, ['.agentrc.json']);
  });

  it('proceeds in a non-repo directory (no .git/) without --yes', () => {
    const dir = track(
      makeFixtureDir({
        asRepo: false,
        files: { '.agentrc.json': V5_AGENTRC },
      }),
    );
    const tree = checkWorkingTree(dir);
    assert.equal(tree.isRepo, false);
    assert.equal(tree.dirty, false);
    const result = runMigration({ cwd: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.written, ['.agentrc.json']);
  });
});

/* ------------------------------------------------------------------------- */
/* Acceptance (d): zero network calls                                        */
/* ------------------------------------------------------------------------- */

describe('migrate-to-v6 — (d) makes zero network calls', () => {
  it('source does not reference any networking module', () => {
    // Read the CLI file and its lib companion; ensure no network surface
    // is wired in. This is a static check, not a runtime one — sufficient
    // because the CLI's only side-effects are fs + git status.
    const here = fileURLToPath(import.meta.url);
    const repoRoot = join(here, '..', '..', '..');
    const cliPath = join(repoRoot, '.agents', 'scripts', 'migrate-to-v6.js');
    const corePath = join(
      repoRoot,
      '.agents',
      'scripts',
      'lib',
      'migrate-to-v6-core.js',
    );
    const cliText = readFileSync(cliPath, 'utf8');
    const coreText = readFileSync(corePath, 'utf8');
    const combined = `${cliText}\n${coreText}`;
    for (const forbidden of [
      'fetch(',
      "from 'node:https'",
      'from "node:https"',
      "from 'node:http'",
      'from "node:http"',
      "from 'node:net'",
      'from "node:net"',
      "from 'node:dns'",
      'from "node:dns"',
      "from 'undici'",
      'from "undici"',
    ]) {
      assert.equal(
        combined.includes(forbidden),
        false,
        `migrate-to-v6 must not reference ${forbidden}`,
      );
    }
  });
});

/* ------------------------------------------------------------------------- */
/* CLI surface — argv parsing + summary formatter                            */
/* ------------------------------------------------------------------------- */

describe('migrate-to-v6 — CLI surface', () => {
  it('parseArgv honours --cwd, --dry-run, --yes, --help', () => {
    const parsed = parseArgv(['--cwd', '/tmp/x', '--dry-run', '--yes']);
    assert.equal(parsed.cwd, '/tmp/x');
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.yes, true);
    assert.equal(parsed.help, false);

    const parsed2 = parseArgv(['-h']);
    assert.equal(parsed2.help, true);
  });

  it('parseArgv defaults cwd to process.cwd() when omitted', () => {
    const parsed = parseArgv([]);
    assert.equal(parsed.cwd, process.cwd());
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.yes, false);
  });

  it('formatSummary reports the already-v6 case explicitly', () => {
    const text = formatSummary({
      agentrc: null,
      gitmodules: null,
      packageJson: null,
      summary: {
        agentrcChanges: 0,
        gitmodulesChanged: false,
        packageJsonChanges: 0,
        totalChanges: 0,
        alreadyV6: true,
      },
    });
    assert.match(text, /Already on v6/u);
  });

  it('--dry-run produces a plan but writes nothing', () => {
    const dir = track(
      makeFixtureDir({
        asRepo: true,
        commit: true,
        files: {
          '.agentrc.json': V5_AGENTRC,
        },
      }),
    );
    const result = runMigration({ cwd: dir, dryRun: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.written, []);
    // Disk content unchanged.
    const onDisk = JSON.parse(readFileSync(join(dir, '.agentrc.json'), 'utf8'));
    assert.deepEqual(onDisk, V5_AGENTRC);
  });
});
