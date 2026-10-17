// tests/cli/registry.test.js
/**
 * Unit tests for lib/cli/registry.js — the mandrel doctor check registry.
 *
 * Each test drives a specific check in isolation via injectable seams so no
 * real child processes are spawned; the Claude projection-parity checks run
 * over a throwaway temp project, since they compare real bytes.
 *
 * Coverage contract (per AC):
 *   1. registry exports an ordered array of 7 check objects shaped { name, run() }
 *   2. Every required check name is present
 *   3. Each run() resolves to { ok, detail, remedy? }
 *   4. github-token check never echoes the token value
 *   5. All checks return the correct shape on both ok=true and ok=false paths
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { syncClaudeAgents } from '../../.agents/scripts/lib/claude/agents-projection.js';
import { syncClaudeCommands } from '../../.agents/scripts/lib/claude/commands-projection.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { registry } from '../../lib/cli/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate a check by name, or throw to fail the test fast.
 *
 * @param {string} name
 */
function findCheck(name) {
  const check = registry.find((c) => c.name === name);
  assert.ok(check, `Expected a check named "${name}" in registry`);
  return check;
}

/**
 * Assert that a result conforms to { ok: boolean, detail: string, remedy?: string }.
 * When ok is false, remedy must be a non-empty string.
 *
 * @param {{ ok: unknown, detail: unknown, remedy?: unknown }} result
 * @param {{ expectOk?: boolean }} [opts]
 */
function assertResultShape(result, { expectOk } = {}) {
  assert.equal(typeof result.ok, 'boolean', 'result.ok must be boolean');
  assert.equal(typeof result.detail, 'string', 'result.detail must be string');
  assert.ok(result.detail.length > 0, 'result.detail must be non-empty');
  if (!result.ok) {
    assert.equal(
      typeof result.remedy,
      'string',
      'result.remedy must be a string when ok is false',
    );
    assert.ok(
      result.remedy.length > 0,
      'result.remedy must be non-empty when ok is false',
    );
  }
  if (expectOk !== undefined) {
    assert.equal(result.ok, expectOk, `Expected result.ok to be ${expectOk}`);
  }
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('registry', () => {
  it('is an array', () => {
    assert.ok(Array.isArray(registry), 'registry must be an array');
  });

  it('contains exactly 20 checks', () => {
    assert.equal(registry.length, 20);
  });

  it('every entry has a string name and a run function', () => {
    for (const check of registry) {
      assert.equal(typeof check.name, 'string', 'check.name must be a string');
      assert.ok(check.name.length > 0, 'check.name must be non-empty');
      assert.equal(
        typeof check.run,
        'function',
        `check "${check.name}".run must be a function`,
      );
    }
  });

  it('contains the required check names in order', () => {
    const expected = [
      'node-version',
      'git-available',
      'gh-available',
      'github-token',
      'gh-auth',
      'github-project-access',
      'commands-in-sync',
      'agents-in-sync',
      'codex-skills-in-sync',
      'codex-agents-in-sync',
      'codex-instructions',
      'runtime-deps',
      'agents-materialized',
      'agents-drift',
      'claude-code-version',
      'llm-review-provider',
      'merge-driver',
      'pin-current',
      'version-current',
      'test-credit-path',
    ];
    assert.deepEqual(
      registry.map((c) => c.name),
      expected,
    );
  });
});

// ---------------------------------------------------------------------------
// node-version
// ---------------------------------------------------------------------------

describe('node-version check', () => {
  it('returns ok=true for a valid node version', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '22.22.1' });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /22\.22\.1/);
  });

  it('returns ok=true for a version in range (e.g. 23.x)', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '23.0.0' });
    assertResultShape(result, { expectOk: true });
  });

  it('returns ok=false for a version below the floor', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '18.0.0' });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Upgrade Node/);
    assert.doesNotMatch(result.detail, /undefined/);
  });

  it('returns ok=false for a version at or above the ceiling', () => {
    const check = findCheck('node-version');
    const result = check.run({ nodeVersion: '25.0.0' });
    assertResultShape(result, { expectOk: false });
  });
});

// ---------------------------------------------------------------------------
// git-available
// ---------------------------------------------------------------------------

describe('git-available check', () => {
  it('returns ok=true when git --version succeeds', () => {
    const check = findCheck('git-available');
    const result = check.run({
      runner: () => ({ status: 0, stdout: 'git version 2.49.0\n', stderr: '' }),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.detail, 'git version 2.49.0');
  });

  it('returns ok=false when git is not on PATH (ENOENT)', () => {
    const check = findCheck('git-available');
    const result = check.run({
      runner: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install git/i);
  });

  it('returns ok=false when git exits non-zero', () => {
    const check = findCheck('git-available');
    const result = check.run({
      runner: () => ({ status: 1, stdout: '', stderr: 'some error' }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install git/i);
  });
});

// ---------------------------------------------------------------------------
// gh-available
// ---------------------------------------------------------------------------

describe('gh-available check', () => {
  it('returns ok=true when gh --version succeeds', () => {
    const check = findCheck('gh-available');
    const result = check.run({
      runner: () => ({
        status: 0,
        stdout:
          'gh version 2.72.0 (2025-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.72.0\n',
        stderr: '',
      }),
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /gh version/);
  });

  it('returns ok=false when gh is not on PATH (ENOENT)', () => {
    const check = findCheck('gh-available');
    const result = check.run({
      runner: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install gh/i);
  });

  it('returns ok=false when gh exits non-zero', () => {
    const check = findCheck('gh-available');
    const result = check.run({
      runner: () => ({ status: 127, stdout: '', stderr: 'command not found' }),
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /Install gh/i);
  });
});

// ---------------------------------------------------------------------------
// github-token
// ---------------------------------------------------------------------------

describe('github-token check', () => {
  // A runner stub that mimics `gh auth token` returning nothing (not
  // authenticated). Lets env-only branches assert without spawning a real gh.
  const noGhToken = () => ({
    status: 1,
    stdout: '',
    stderr: 'not logged in',
    error: undefined,
  });

  it('returns ok=true when GITHUB_TOKEN is set', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: { GITHUB_TOKEN: 'ghp_supersecret' },
      runner: noGhToken,
    });
    assertResultShape(result, { expectOk: true });
    // Token value must never appear in detail or remedy.
    assert.doesNotMatch(result.detail, /ghp_supersecret/);
    if (result.remedy) {
      assert.doesNotMatch(result.remedy, /ghp_supersecret/);
    }
  });

  it('returns ok=true when GH_TOKEN is set (env alias, parity with runtime resolver)', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: { GH_TOKEN: 'gho_aliassecret' },
      runner: noGhToken,
    });
    assertResultShape(result, { expectOk: true });
    assert.doesNotMatch(result.detail, /gho_aliassecret/);
  });

  it('returns ok=true via the `gh auth token` fallback when env is unset (Story #3893)', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: {},
      runner: (cmd, args) => {
        assert.equal(cmd, 'gh');
        assert.deepEqual(args, ['auth', 'token']);
        return {
          status: 0,
          stdout: 'ghp_resolvedviaghcli\n',
          stderr: '',
          error: undefined,
        };
      },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /gh auth token/);
    // The resolved token value must never leak into detail.
    assert.doesNotMatch(result.detail, /ghp_resolvedviaghcli/);
  });

  it('returns ok=false with an accurate remedy when env is unset and gh has no token', () => {
    const check = findCheck('github-token');
    const result = check.run({ env: {}, runner: noGhToken });
    assertResultShape(result, { expectOk: false });
    // Remedy must point at the path the runtime actually uses (gh auth login)
    // and must not promise a `.env` path the CLI cannot read (Finding A.4).
    assert.match(result.remedy, /gh auth login/);
    assert.doesNotMatch(result.remedy, /\.env/);
  });

  it('returns ok=false when gh CLI is missing (ENOENT) and env is unset', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: {},
      runner: () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
      }),
    });
    assertResultShape(result, { expectOk: false });
  });

  it('treats an empty GITHUB_TOKEN as unset and falls through to gh fallback', () => {
    const check = findCheck('github-token');
    const result = check.run({
      env: { GITHUB_TOKEN: '' },
      runner: () => ({
        status: 0,
        stdout: 'ghp_fromgh\n',
        stderr: '',
        error: undefined,
      }),
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /gh auth token/);
  });

  it('never echoes a real-looking token value in detail or remedy', () => {
    const sensitiveToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const check = findCheck('github-token');
    const result = check.run({
      env: { GITHUB_TOKEN: sensitiveToken },
      runner: noGhToken,
    });
    assert.doesNotMatch(result.detail, /ghp_/i);
    if (result.remedy) {
      assert.doesNotMatch(result.remedy, new RegExp(sensitiveToken));
    }
  });
});

// ---------------------------------------------------------------------------
// gh-auth
// ---------------------------------------------------------------------------

describe('gh-auth check', () => {
  it('returns ok=true when gh auth status succeeds and parses the username', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({
        status: 0,
        stdout: '',
        stderr: '✓ Logged in to github.com as dsj1984 (oauth_token)',
      }),
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /dsj1984/);
  });

  it('returns ok=true when gh auth status succeeds without a parseable username', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({ status: 0, stdout: 'authenticated', stderr: '' }),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.detail, 'logged in');
  });

  it('returns ok=false when gh auth status exits non-zero and no env token is present', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({ status: 1, stdout: '', stderr: 'not logged in' }),
      env: {},
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /gh auth login/);
  });

  it('degrades to ok=true when gh auth status fails but GITHUB_TOKEN is set (CI installation token)', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({
        status: 1,
        stdout: '',
        stderr: 'The token in GH_TOKEN is invalid.',
      }),
      env: { GITHUB_TOKEN: 'ghs_actions_installation_token' },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /GITHUB_TOKEN\/GH_TOKEN is set/);
    assert.equal(result.remedy, undefined);
  });

  it('degrades to ok=true when gh auth status fails but GH_TOKEN is set', () => {
    const check = findCheck('gh-auth');
    const result = check.run({
      runner: () => ({ status: 1, stdout: '', stderr: 'not logged in' }),
      env: { GH_TOKEN: 'gho_some_token' },
    });
    assertResultShape(result, { expectOk: true });
  });
});

// ---------------------------------------------------------------------------
// commands-in-sync / agents-in-sync — byte parity over a real temp project
// ---------------------------------------------------------------------------

/**
 * A throwaway project root seeded with `files` (project-relative path →
 * content). The Claude parity checks compare real bytes, so they run over a
 * real tree rather than a readDir fake.
 *
 * @param {Record<string, string>} files
 * @returns {string}
 */
function seedProject(files) {
  const root = makeTempDir('registry-sync-parity-');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

const WORKFLOW = '---\ndescription: normal\n---\n\n# Normal\n';
const EXCLUDED = '---\ndescription: lens\ncommand: false\n---\n\n# Lens\n';
const ROLE = '---\nname: worker\nmodel: inherit\n---\n\n# Worker\n';

describe('commands-in-sync check', () => {
  const run = (root) =>
    findCheck('commands-in-sync').run({ projectRoot: root });

  /** Seed sources, project them for real, return the root. */
  function synced(files) {
    const root = seedProject(files);
    syncClaudeCommands({ projectRoot: root });
    return root;
  }

  it('returns ok=true when the projection matches the sources', () => {
    const root = synced({
      '.agents/workflows/epic-deliver.md': WORKFLOW,
      '.agents/workflows/story-deliver.md': WORKFLOW,
      '.agents/workflows/loops/tick.md': WORKFLOW,
    });
    const result = run(root);
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /3 commands up to date/);
  });

  it('returns ok=false when a source file is not in the destination', () => {
    const root = synced({ '.agents/workflows/epic-deliver.md': WORKFLOW });
    fs.writeFileSync(
      path.join(root, '.agents', 'workflows', 'story-deliver.md'),
      WORKFLOW,
    );
    const result = run(root);
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /sync:commands/);
    assert.match(result.detail, /1 not synced/);
  });

  it('returns ok=false when the destination has a stale file not in source', () => {
    const root = synced({ '.agents/workflows/epic-deliver.md': WORKFLOW });
    fs.writeFileSync(
      path.join(root, '.claude', 'commands', 'old-command.md'),
      '# old\n',
    );
    const result = run(root);
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /1 stale/);
  });

  // Story #5742 AC-4 — a same-name command with stale bytes fails, not only a
  // missing or extra file.
  it('returns ok=false when a same-name command holds stale content', () => {
    const root = synced({ '.agents/workflows/epic-deliver.md': WORKFLOW });
    fs.writeFileSync(
      path.join(root, '.agents', 'workflows', 'epic-deliver.md'),
      `${WORKFLOW}\nEdited after the last sync.\n`,
    );
    const result = run(root);
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /1 stale/);
    assert.match(result.remedy, /sync:commands/);
  });

  // Story #3588 — without an explicit projectRoot the check MUST anchor on
  // the consumer dir (cwd()), not the package-relative resolveProjectRoot()
  // climb that lands in node_modules in a real install.
  it('defaults the root to cwd() (the consumer dir), not the package-relative climb', () => {
    const root = synced({ '.agents/workflows/epic-deliver.md': WORKFLOW });
    const result = findCheck('commands-in-sync').run({ cwd: () => root });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /1 commands up to date/);
  });

  // #4482 — a `command: false` workflow is not expected.
  it('excludes frontmatter `command: false` workflows from the expected set', () => {
    const root = synced({
      '.agents/workflows/audit-security.md': EXCLUDED,
      '.agents/workflows/epic-deliver.md': WORKFLOW,
    });
    const result = run(root);
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /1 commands up to date/);
  });

  // #4721 — a dest command backed only by a local workflow is in sync.
  it('counts a dest command backed only by a local workflow as in sync (#4721)', () => {
    const root = synced({
      '.agents/workflows/epic-deliver.md': WORKFLOW,
      '.agents/local/workflows/benchmark.md': WORKFLOW,
    });
    const result = run(root);
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /2 commands up to date/);
  });

  it('reports a local workflow with no dest counterpart as not synced', () => {
    const root = synced({ '.agents/workflows/epic-deliver.md': WORKFLOW });
    const local = path.join(root, '.agents', 'local', 'workflows');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'benchmark.md'), WORKFLOW);
    const result = run(root);
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /1 not synced/);
  });

  it('applies the `command: false` exclusion to local sources too', () => {
    const root = synced({
      '.agents/workflows/epic-deliver.md': WORKFLOW,
      '.agents/local/workflows/local-lens.md': EXCLUDED,
    });
    const result = run(root);
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /1 commands up to date/);
  });

  // Payload-wins shadowing: an excluded payload copy never claims its name,
  // so the local copy projects.
  it('counts a basename supplied by both sources once, and a payload-excluded/local-projected basename as expected', () => {
    const root = synced({
      '.agents/workflows/shared.md': WORKFLOW,
      '.agents/workflows/lens.md': EXCLUDED,
      '.agents/local/workflows/shared.md': WORKFLOW,
      '.agents/local/workflows/lens.md': WORKFLOW,
    });
    const result = run(root);
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /2 commands up to date/);
  });
});

describe('agents-in-sync check', () => {
  const run = (root, opts = {}) =>
    findCheck('agents-in-sync').run({ projectRoot: root, ...opts });

  /** Seed sources, project them for real, return the root. */
  function synced(files) {
    const root = seedProject(files);
    syncClaudeAgents({ projectRoot: root });
    return root;
  }

  it('returns ok=true when the projection matches the sources', () => {
    const root = synced({
      '.agents/agents/story-worker.md': ROLE,
      '.agents/agents/acceptance-critic.md': ROLE,
      '.agents/agents/retro.md': ROLE,
    });
    const result = run(root);
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /3 agents up to date/);
  });

  it('is a clean no-op when there are no agent sources or dests', () => {
    const result = run(seedProject({}));
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /0 agents up to date/);
  });

  // Story #4530 (M7-B): under the default roleScopedAgents:true an
  // unmaterialized tree is a readiness failure.
  it('is fatal (ok:false) when sources exist, the dest tree is empty, and roleScopedAgents is true (default)', () => {
    const root = seedProject({
      '.agents/agents/story-worker.md': ROLE,
      '.agents/agents/acceptance-critic.md': ROLE,
      '.agents/agents/retro.md': ROLE,
    });
    const result = run(root, { roleScopedAgents: true });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /3 agent def\(s\) not yet materialized/);
    assert.doesNotMatch(result.detail, /inert/);
    assert.match(result.remedy, /mandrel sync-agents/);
  });

  // roleScopedAgents:false is the documented kill-switch.
  it('stays advisory (ok:true) when sources exist, the dest tree is empty, and roleScopedAgents is false', () => {
    const root = seedProject({
      '.agents/agents/story-worker.md': ROLE,
      '.agents/agents/acceptance-critic.md': ROLE,
      '.agents/agents/retro.md': ROLE,
    });
    const result = run(root, { roleScopedAgents: false });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /3 agent def\(s\) not materialized/);
    assert.match(result.detail, /roleScopedAgents is disabled/);
  });

  it('returns ok=false when a source def is not in the destination', () => {
    const root = synced({ '.agents/agents/story-worker.md': ROLE });
    fs.writeFileSync(path.join(root, '.agents', 'agents', 'retro.md'), ROLE);
    const result = run(root);
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /mandrel sync-agents/);
    assert.match(result.detail, /1 not synced/);
  });

  it('returns ok=false when the destination has a stale def not in source', () => {
    const root = synced({ '.agents/agents/story-worker.md': ROLE });
    fs.writeFileSync(
      path.join(root, '.claude', 'agents', 'old-agent.md'),
      ROLE,
    );
    const result = run(root);
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /1 stale/);
  });

  // Story #5742 AC-4 — a same-name agent with stale bytes fails.
  it('returns ok=false when a same-name agent holds stale content', () => {
    const root = synced({ '.agents/agents/story-worker.md': ROLE });
    fs.writeFileSync(
      path.join(root, '.agents', 'agents', 'story-worker.md'),
      `${ROLE}\nEdited after the last sync.\n`,
    );
    const result = run(root);
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /1 stale/);
    assert.match(result.remedy, /mandrel sync-agents/);
  });

  it('an agentModels override changes the expected bytes', () => {
    const root = synced({ '.agents/agents/story-worker.md': ROLE });
    fs.writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify({
        delivery: { routing: { agentModels: { 'story-worker': 'sonnet' } } },
      }),
    );
    assertResultShape(run(root), { expectOk: false });
    syncClaudeAgents({ projectRoot: root });
    assertResultShape(run(root), { expectOk: true });
  });

  it('defaults the root to cwd() (the consumer dir), not the package-relative climb', () => {
    const root = synced({ '.agents/agents/story-worker.md': ROLE });
    const result = findCheck('agents-in-sync').run({ cwd: () => root });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /1 agents up to date/);
  });
});

// ---------------------------------------------------------------------------
// runtime-deps
// ---------------------------------------------------------------------------

describe('runtime-deps check', () => {
  it('returns ok=true when all required deps resolve', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['ajv', 'js-yaml'],
      resolve: () => '/fake/path/to/module',
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /all dependencies found/);
  });

  it('returns ok=false when a dep is missing', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['ajv', 'missing-pkg'],
      resolve: (specifier) => {
        // Absent by every specifier, bare name and manifest subpath alike.
        // The probe tries both, because a package with no `main` and no
        // `exports` does not resolve by name even when installed — so a fake
        // that rejects only the bare name describes an installed package.
        if (specifier.startsWith('missing-pkg')) {
          throw new Error('MODULE_NOT_FOUND');
        }
        return '/fake/path';
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /missing-pkg/);
    // Remedy names the real cause (consumer-root resolution) and the pnpm
    // hoist fix that operators who hit this actually need.
    assert.match(result.remedy, /pnpm/i);
    assert.match(result.remedy, /hoist/i);
  });

  it('returns ok=true for an empty manifest', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({ manifestRequired: [] });
    assertResultShape(result, { expectOk: true });
  });

  it('lists all missing packages in detail and remedy', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['pkg-a', 'pkg-b'],
      resolve: () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.detail, /pkg-a/);
    assert.match(result.detail, /pkg-b/);
    assert.match(result.remedy, /pkg-a/);
    assert.match(result.remedy, /pkg-b/);
  });

  it('still resolves all deps via the real require seam (behaviour unchanged)', () => {
    const check = findCheck('runtime-deps');
    const result = check.run({
      manifestRequired: ['ajv'],
      resolve: () => '/fake/path/to/ajv',
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /all dependencies found/);
  });
});

// ---------------------------------------------------------------------------
// agents-materialized
// ---------------------------------------------------------------------------

describe('agents-materialized check', () => {
  it('returns ok=true when ./.agents/instructions.md exists', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: (p) => p.includes('instructions.md'),
      // resolvePackage must not be consulted on the green path; throw to prove it.
      resolvePackage: () => {
        throw new Error(
          'resolvePackage should not be called when materialized',
        );
      },
    });
    assertResultShape(result, { expectOk: true });
    assert.match(result.detail, /materialized/);
  });

  it('returns ok=false with a `mandrel sync` remedy when the package is installed but ./.agents/ is absent', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: () => false,
      resolvePackage: () => '/fake/project/node_modules/mandrel/package.json',
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /mandrel sync/);
  });

  it('returns ok=false with an install remedy when neither ./.agents/ nor the package is present', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: () => false,
      resolvePackage: () => {
        throw Object.assign(new Error('Cannot find module'), {
          code: 'MODULE_NOT_FOUND',
        });
      },
    });
    assertResultShape(result, { expectOk: false });
    assert.match(result.remedy, /npm install mandrel/);
  });

  it('does not echo file contents — detail and remedy are path/instruction only', () => {
    const check = findCheck('agents-materialized');
    const result = check.run({
      cwd: () => '/fake/project',
      existsSync: () => false,
      resolvePackage: () => '/fake/project/node_modules/mandrel/package.json',
    });
    assert.doesNotMatch(result.detail, /\n/);
  });
});

describe('test-credit-path pre-push gate detector', () => {
  const ROOT = path.resolve('/consumer');
  const run = (hook) =>
    findCheck('test-credit-path').run({
      projectRoot: ROOT,
      readFile: (file) => {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        if (rel === 'package.json') {
          return JSON.stringify({
            scripts: { test: 'node .agents/scripts/run-tests.js' },
          });
        }
        if (rel === '.husky/pre-push') return hook;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });

  // This repo's own pre-push shape: lint named only in comments.
  const COMMENT_ONLY_HOOK = [
    '#!/usr/bin/env sh',
    '# Runs no lint, docs:check, or the full test suite.',
    '# That runs audit → lint (biome + docs:check) → npm test.',
    'cat > /dev/null',
    'npm run crap:check',
    '  # It is also a lint task, and this hook runs no lint.',
    'node scripts/check-comment-policy.js',
    '',
  ].join('\n');

  it('does not flag a hook whose comments mention lint but whose commands do not', () => {
    const result = run(COMMENT_ONLY_HOOK);
    assert.equal(result.remedy, undefined);
    assert.match(result.detail, /runs no typecheck or lint gate/);
  });

  it('still flags a hook that actually invokes lint without evidence-gate.js', () => {
    const result = run(`${COMMENT_ONLY_HOOK}npm run lint\n`);
    assert.match(result.remedy, /evidence-gate\.js/);
    assert.match(
      result.detail,
      /runs typecheck or lint without `evidence-gate\.js`/,
    );
  });
});
