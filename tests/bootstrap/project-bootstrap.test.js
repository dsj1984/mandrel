/**
 * project-bootstrap.test — Story #2074
 *
 * Exercises the per-step helpers in
 * `.agents/scripts/lib/bootstrap/project-bootstrap.js` against a tmp
 * project tree. Each helper must be idempotent: running it twice with
 * unchanged inputs produces zero mutations on the second run.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { normalizeHandleAnswer } from '../../.agents/scripts/bootstrap.js';
import {
  checkNodeVersion,
  detectPackageManager,
  ensureAgentrc,
  ensureClaudeSettings,
  ensureGitignore,
  ensurePackageJson,
  REQUIRED_NODE_FLOOR,
  SYNC_COMMAND,
  satisfiesNodeEngine,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';

let tmpRoot;

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-bootstrap-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('satisfiesNodeEngine', () => {
  it('accepts the engines floor and supported majors below 25', () => {
    assert.equal(satisfiesNodeEngine('22.22.1'), true);
    assert.equal(satisfiesNodeEngine('24.0.0'), true);
  });

  it('rejects versions below the floor and at/above major 25', () => {
    assert.equal(satisfiesNodeEngine('22.22.0'), false);
    assert.equal(satisfiesNodeEngine('21.0.0'), false);
    assert.equal(satisfiesNodeEngine('25.0.0'), false);
  });
});

describe('checkNodeVersion', () => {
  it('reports the running Node version against the engines floor', () => {
    const result = checkNodeVersion();
    assert.equal(result.required, REQUIRED_NODE_FLOOR);
    assert.ok(typeof result.version === 'string');
    assert.equal(typeof result.ok, 'boolean');
  });

  it('rejects injected versions below the engines floor', () => {
    const result = checkNodeVersion('20.0.0');
    assert.equal(result.ok, false);
    assert.equal(result.version, '20.0.0');
  });
});

describe('detectPackageManager', () => {
  it('returns npm by default', () => {
    assert.equal(detectPackageManager(tmpRoot), 'npm');
  });

  it('prefers pnpm when pnpm-lock.yaml is present', () => {
    writeFile(path.join(tmpRoot, 'pnpm-lock.yaml'), '');
    assert.equal(detectPackageManager(tmpRoot), 'pnpm');
  });

  it('prefers yarn when yarn.lock is present', () => {
    writeFile(path.join(tmpRoot, 'yarn.lock'), '');
    assert.equal(detectPackageManager(tmpRoot), 'yarn');
  });
});

describe('ensurePackageJson', () => {
  it('creates a fresh package.json with the sync wiring on a green-field repo', () => {
    const outcome = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(outcome.created, true);
    assert.equal(outcome.scriptsSyncCommands, 'added');
    assert.equal(outcome.scriptsPrepare, 'added');
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(pkg.scripts['sync:commands'], SYNC_COMMAND);
    assert.equal(pkg.scripts.prepare, SYNC_COMMAND);
  });

  it('never seeds framework runtime deps into the consumer manifest', () => {
    // Story #3466: the dependency-merge loop was removed — framework deps
    // arrive transitively via @mandrelai/agents, so bootstrap must leave the
    // consumer manifest's dependency surface entirely untouched.
    const outcome = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(Object.hasOwn(outcome, 'deps'), false);
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(Object.hasOwn(pkg, 'dependencies'), false);
  });

  it('leaves a pre-existing dependencies block unmutated', () => {
    writeFile(
      path.join(tmpRoot, 'package.json'),
      `${JSON.stringify(
        { name: 'host', dependencies: { 'left-pad': '^1.0.0' } },
        null,
        2,
      )}\n`,
    );
    ensurePackageJson({ projectRoot: tmpRoot });
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.deepEqual(pkg.dependencies, { 'left-pad': '^1.0.0' });
  });

  it('appends sync to an existing prepare without clobbering it', () => {
    writeFile(
      path.join(tmpRoot, 'package.json'),
      `${JSON.stringify({ name: 'host', scripts: { prepare: 'husky' } }, null, 2)}\n`,
    );
    const outcome = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(outcome.scriptsPrepare, 'appended');
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(pkg.scripts.prepare, `husky && ${SYNC_COMMAND}`);
  });

  it('is idempotent on the second run', () => {
    ensurePackageJson({ projectRoot: tmpRoot });
    const second = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(second.created, false);
    assert.equal(second.scriptsSyncCommands, 'already-present');
    assert.equal(second.scriptsPrepare, 'already-present');
    assert.equal(second.mutated, false);
  });
});

describe('ensureClaudeSettings', () => {
  it('creates a fresh settings.json with the sync hook (no plugin enablement)', () => {
    const outcome = ensureClaudeSettings({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'created');
    const settings = readJson(path.join(tmpRoot, '.claude', 'settings.json'));
    const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(cmd.includes('sync-claude-commands.js'));
    // Flat /<name> commands need no plugin enablement — the #3576 plugin
    // cutover was reverted, so these keys must NOT be written.
    assert.equal(settings.enabledPlugins, undefined);
    assert.equal(settings.extraKnownMarketplaces, undefined);
  });

  it('merges into an existing settings.json without duplicating', () => {
    writeFile(
      path.join(tmpRoot, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [] } }),
    );
    const first = ensureClaudeSettings({ projectRoot: tmpRoot });
    const second = ensureClaudeSettings({ projectRoot: tmpRoot });
    assert.equal(first.action, 'merged');
    assert.equal(second.action, 'already-present');
    const settings = readJson(path.join(tmpRoot, '.claude', 'settings.json'));
    const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(cmd.includes('sync-claude-commands.js'));
    assert.equal(settings.enabledPlugins, undefined);
  });
});

describe('ensureGitignore', () => {
  it('creates a fresh .gitignore with both blocks', () => {
    const outcome = ensureGitignore({ projectRoot: tmpRoot });
    assert.equal(outcome.commands, 'added');
    assert.equal(outcome.mcp, 'added');
    const body = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    // The flat .claude/commands/ tree is the ignored generated path.
    assert.ok(body.includes('.claude/commands/'));
    assert.ok(body.includes('.mcp.json'));
  });

  it('skips already-present entries', () => {
    writeFile(
      path.join(tmpRoot, '.gitignore'),
      'node_modules/\n.claude/commands/\n.mcp.json\n',
    );
    const outcome = ensureGitignore({ projectRoot: tmpRoot });
    assert.equal(outcome.commands, 'already-present');
    assert.equal(outcome.mcp, 'already-present');
  });
});

describe('ensureAgentrc', () => {
  it('skips when .agentrc.json already exists', () => {
    writeFile(
      path.join(tmpRoot, '.agentrc.json'),
      '{"project":{"baseBranch":"main"}}',
    );
    const outcome = ensureAgentrc({
      projectRoot: tmpRoot,
      answers: {
        owner: 'a',
        repo: 'b',
        operatorHandle: 'c',
        baseBranch: 'main',
      },
    });
    assert.equal(outcome.action, 'already-present');
  });

  it('reports missing-starter when the framework starter is absent', () => {
    const outcome = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot: path.join(tmpRoot, '.agents-missing'),
      answers: {
        owner: 'a',
        repo: 'b',
        operatorHandle: 'c',
        baseBranch: 'main',
      },
    });
    assert.equal(outcome.action, 'missing-starter');
  });

  it('seeds from the starter and replaces placeholders', () => {
    const fakeAgentRoot = path.join(tmpRoot, '.agents');
    writeFile(
      path.join(fakeAgentRoot, 'starter-agentrc.json'),
      JSON.stringify({
        project: { baseBranch: 'main' },
        github: {
          owner: '[OWNER]',
          repo: '[REPO]',
          operatorHandle: '@[USERNAME]',
        },
      }),
    );
    const outcome = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot: fakeAgentRoot,
      answers: {
        owner: 'acme',
        repo: 'widget',
        operatorHandle: 'me',
        baseBranch: 'trunk',
      },
    });
    assert.equal(outcome.action, 'seeded');
    const seeded = readJson(path.join(tmpRoot, '.agentrc.json'));
    assert.equal(seeded.github.owner, 'acme');
    assert.equal(seeded.github.repo, 'widget');
    assert.equal(seeded.github.operatorHandle, '@me');
    assert.equal(seeded.project.baseBranch, 'trunk');
  });

  // Story #3700 — a flag/env-supplied `@`-prefixed handle, after the
  // bootstrap's `normalizeHandleAnswer`, seeds a single-`@` value (not `@@me`)
  // and a second seed run is a no-op (operator wins).
  it('seeds a single-@ handle from an @-prefixed answer and is idempotent', () => {
    const fakeAgentRoot = path.join(tmpRoot, '.agents');
    writeFile(
      path.join(fakeAgentRoot, 'starter-agentrc.json'),
      JSON.stringify({
        project: { baseBranch: 'main' },
        github: {
          owner: '[OWNER]',
          repo: '[REPO]',
          operatorHandle: '@[USERNAME]',
        },
      }),
    );
    const answers = {
      owner: 'acme',
      repo: 'widget',
      // The starter prepends `@`; the bootstrap strips one leading `@` first.
      operatorHandle: normalizeHandleAnswer('@me'),
      baseBranch: 'main',
    };
    const first = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot: fakeAgentRoot,
      answers,
    });
    assert.equal(first.action, 'seeded');
    const seeded = readJson(path.join(tmpRoot, '.agentrc.json'));
    assert.equal(seeded.github.operatorHandle, '@me');

    // Second run: the file already exists → no-op, no double-@ accumulation.
    const before = fs.readFileSync(path.join(tmpRoot, '.agentrc.json'), 'utf8');
    const second = ensureAgentrc({
      projectRoot: tmpRoot,
      agentRoot: fakeAgentRoot,
      answers,
    });
    assert.equal(second.action, 'already-present');
    assert.equal(
      fs.readFileSync(path.join(tmpRoot, '.agentrc.json'), 'utf8'),
      before,
    );
  });
});
