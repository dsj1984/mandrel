/**
 * bootstrap-preflight.test — Story #3375
 *
 * Exercises the unified prerequisite preflight:
 *
 *   1. runPreflight()        — aggregates Node / git / inside-work-tree /
 *                              gh checks; ok is false when any fails; each
 *                              failing check carries a remedy; skipGithub
 *                              drops the gh checks but keeps Node + git.
 *   2. runPreflightPhase()   — the bootstrap pipeline phase wrapper; halts
 *                              with exit 1 and prints remedies on failure,
 *                              advances with the preflight payload on pass.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPreflightPhase } from '../../.agents/scripts/bootstrap.js';
import { runPreflight } from '../../.agents/scripts/lib/bootstrap/preflight.js';

// --- Stub runners -----------------------------------------------------------

const okNode = () => ({ ok: true, version: '22.22.1', required: '22.22.1' });
const oldNode = () => ({ ok: false, version: '18.0.0', required: '22.22.1' });

function gitRunnerStub({
  availableStatus = 0,
  insideStatus = 0,
  inside = 'true',
  enoent = false,
} = {}) {
  return (args) => {
    if (enoent) {
      return {
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
      };
    }
    if (args[0] === '--version') {
      return {
        status: availableStatus,
        stdout: availableStatus === 0 ? 'git version 2.43.0' : '',
        stderr: availableStatus === 0 ? '' : 'boom',
      };
    }
    if (args[0] === 'rev-parse') {
      return {
        status: insideStatus,
        stdout: insideStatus === 0 ? `${inside}\n` : '',
        stderr: insideStatus === 0 ? '' : 'not a git repo',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

const okGh = async () => ({ version: '2.50.0' });
const failGh = async () => {
  throw new Error('gh auth status failed: not logged in. Run `gh auth login`.');
};

describe('runPreflight', () => {
  it('returns ok=true when every check passes', async () => {
    const res = await runPreflight({
      nodeCheck: okNode,
      gitRunner: gitRunnerStub(),
      gh: okGh,
    });
    assert.equal(res.ok, true);
    const names = res.checks.map((c) => c.name);
    assert.deepEqual(names, ['node', 'git', 'git-work-tree', 'gh']);
    assert.ok(res.checks.every((c) => c.ok));
    assert.ok(res.checks.every((c) => c.remedy === undefined));
  });

  it('skips the gh check when skipGithub is true but still runs node + git', async () => {
    const res = await runPreflight({
      skipGithub: true,
      nodeCheck: okNode,
      gitRunner: gitRunnerStub(),
      gh: async () => {
        throw new Error('gh should not be called');
      },
    });
    assert.equal(res.ok, true);
    const names = res.checks.map((c) => c.name);
    assert.deepEqual(names, ['node', 'git', 'git-work-tree']);
  });

  it('fails (ok=false) with a node remedy when Node is too old', async () => {
    const res = await runPreflight({
      skipGithub: true,
      nodeCheck: oldNode,
      gitRunner: gitRunnerStub(),
    });
    assert.equal(res.ok, false);
    const node = res.checks.find((c) => c.name === 'node');
    assert.equal(node.ok, false);
    assert.match(node.remedy, /18\.0\.0/);
    assert.match(node.remedy, /below required 22\.22\.1/);
  });

  it('fails with a git-install remedy when git is not on PATH (ENOENT)', async () => {
    const res = await runPreflight({
      skipGithub: true,
      nodeCheck: okNode,
      gitRunner: gitRunnerStub({ enoent: true }),
    });
    assert.equal(res.ok, false);
    const git = res.checks.find((c) => c.name === 'git');
    assert.equal(git.ok, false);
    assert.match(git.remedy, /Install git/);
    // inside-work-tree is not probed when git itself is missing
    assert.equal(
      res.checks.find((c) => c.name === 'git-work-tree'),
      undefined,
    );
  });

  it('fails with a git remedy when git --version exits non-zero', async () => {
    const res = await runPreflight({
      skipGithub: true,
      nodeCheck: okNode,
      gitRunner: gitRunnerStub({ availableStatus: 1 }),
    });
    assert.equal(res.ok, false);
    const git = res.checks.find((c) => c.name === 'git');
    assert.equal(git.ok, false);
    assert.match(git.remedy, /git --version failed/);
  });

  it('fails with a work-tree remedy when not inside a git work tree', async () => {
    const res = await runPreflight({
      skipGithub: true,
      nodeCheck: okNode,
      gitRunner: gitRunnerStub({ insideStatus: 128 }),
    });
    assert.equal(res.ok, false);
    const wt = res.checks.find((c) => c.name === 'git-work-tree');
    assert.equal(wt.ok, false);
    assert.match(wt.remedy, /inside a git repository/);
  });

  it('treats rev-parse stdout other than "true" as outside a work tree', async () => {
    const res = await runPreflight({
      skipGithub: true,
      nodeCheck: okNode,
      gitRunner: gitRunnerStub({ inside: 'false' }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.checks.find((c) => c.name === 'git-work-tree').ok, false);
  });

  it('surfaces the gh error message as the gh remedy when preflightGh throws', async () => {
    const res = await runPreflight({
      nodeCheck: okNode,
      gitRunner: gitRunnerStub(),
      gh: failGh,
    });
    assert.equal(res.ok, false);
    const gh = res.checks.find((c) => c.name === 'gh');
    assert.equal(gh.ok, false);
    assert.match(gh.remedy, /not logged in/);
  });
});

describe('runPreflightPhase', () => {
  it('advances with the preflight payload when all checks pass', async () => {
    const res = await runPreflightPhase(
      { flags: {} },
      { run: async () => ({ ok: true, checks: [{ name: 'node', ok: true }] }) },
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.preflight.ok, true);
  });

  it('halts with exit 1 and reports failing remedies on a failed preflight', async () => {
    const res = await runPreflightPhase(
      { flags: {} },
      {
        run: async () => ({
          ok: false,
          checks: [
            { name: 'node', ok: true },
            { name: 'git', ok: false, remedy: 'Install git: ...' },
          ],
        }),
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
  });

  it('threads skipGithub from --skip-github into runPreflight', async () => {
    let seen;
    await runPreflightPhase(
      { flags: { 'skip-github': true } },
      {
        run: async (o) => {
          seen = o.skipGithub;
          return { ok: true, checks: [] };
        },
      },
    );
    assert.equal(seen, true);
  });
});
