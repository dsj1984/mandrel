// tests/lib/orchestration/git-cleanup-prune-report.integration.test.js
//
// Real-git round-trip tests for the prune-remotes reporting contract
// (Story #4772). `pruneRemoteTracking` reads the short ref names it reports
// out of `git fetch --prune`'s own progress output, so the *argv* and the
// parser are one contract: a `--quiet` fetch still prunes, but prints
// nothing, and the phase reports `pruned: []` for work it actually did.
// Only a real git can prove the two halves still meet — a mocked spawn
// asserts whatever stderr the test author writes into it.
//
// These spawn real git processes against a tmp two-clone fixture and take
// longer than the mocked unit suite in tests/scripts/git-cleanup.test.js;
// excluded from `test:quick`, run under `test:integration` / `npm test`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { pruneRemoteTracking } from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/git-probes.js';
import {
  executePrune,
  parsePrunedRefs,
} from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/prune.js';
import {
  buildJsonEnvelope,
  computeExitCode,
} from '../../../.agents/scripts/lib/orchestration/git-cleanup/phases/render.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { seedGitIdentity } from '../../fixtures/git-fixture.js';

// Strip every GIT_* env var so the tmpdir cwd wins even when this suite
// runs inside a git hook (husky pre-push exports GIT_DIR / GIT_WORK_TREE /
// etc that would otherwise override execFileSync's `cwd`).
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const SILENT_LOGGER = { info() {}, warn() {} };

function run(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: CLEAN_ENV,
  });
}

/**
 * Remote-tracking refs the clone currently holds, e.g. `origin/fix/old`.
 * `refs/remotes/origin/HEAD` shortens to the bare `origin`, so that entry is
 * the clone's symbolic default-branch pointer, not a branch.
 */
function remoteRefs(clone) {
  return run(
    clone,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes/origin',
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

describe('git-cleanup prune reporting (real git, Story #4772)', () => {
  let base;
  let origin;
  let clone;

  beforeEach(() => {
    base = fs.realpathSync.native(makeTempDir('git-cleanup-prune-'));
    origin = path.join(base, 'origin');
    clone = path.join(base, 'clone');

    fs.mkdirSync(origin);
    run(origin, 'init', '-b', 'main');
    seedGitIdentity(origin);
    fs.writeFileSync(path.join(origin, 'README.md'), 'root\n');
    run(origin, 'add', '.');
    run(origin, 'commit', '-m', 'init');
    // Two side branches the clone will pick up as remote-tracking refs.
    run(origin, 'branch', 'fix/old');
    run(origin, 'branch', 'story-319');

    run(base, 'clone', origin, clone);
    seedGitIdentity(clone);

    // GitHub's auto-delete-on-merge, simulated: the branches vanish from the
    // origin while the clone still tracks them.
    run(origin, 'branch', '-D', 'fix/old');
    run(origin, 'branch', '-D', 'story-319');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reports the short names of the refs it pruned', () => {
    assert.deepEqual(remoteRefs(clone).sort(), [
      'origin',
      'origin/fix/old',
      'origin/main',
      'origin/story-319',
    ]);

    const res = pruneRemoteTracking(clone, 'origin', parsePrunedRefs);

    assert.equal(res.ok, true);
    assert.deepEqual(
      [...res.pruned].sort(),
      ['fix/old', 'story-319'],
      'pruneRemoteTracking must report the refs it dropped — a silent fetch ' +
        'prunes the refs but leaves `pruned` empty',
    );
    // The refs really are gone: reporting and effect agree.
    assert.deepEqual(remoteRefs(clone).sort(), ['origin', 'origin/main']);
  });

  it('populates prune.pruned in the --json envelope and exits 0 for a prune-only run', () => {
    const prune = executePrune({
      cwd: clone,
      remoteName: 'origin',
      logger: SILENT_LOGGER,
    });

    const envelope = buildJsonEnvelope({
      dryRun: false,
      baseBranch: 'main',
      plan: { candidates: [], skipped: [] },
      prune,
    });
    assert.deepEqual([...envelope.prune.pruned].sort(), [
      'fix/old',
      'story-319',
    ]);

    // A `--prune-remotes --execute` run: prune is the only active phase and
    // it dropped stale refs, so the run did work — exit 0, not 2.
    assert.equal(computeExitCode({ prune }), 0);
  });

  it('reports an empty prune and exits 2 when the clone is already tidy', () => {
    executePrune({ cwd: clone, remoteName: 'origin', logger: SILENT_LOGGER });

    const second = executePrune({
      cwd: clone,
      remoteName: 'origin',
      logger: SILENT_LOGGER,
    });

    assert.equal(second.ok, true);
    assert.deepEqual(second.pruned, []);
    assert.equal(computeExitCode({ prune: second }), 2);
  });
});
