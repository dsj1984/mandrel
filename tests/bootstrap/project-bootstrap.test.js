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
import { LEDGER_RELATIVE_PATH } from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import {
  checkNodeVersion,
  checkParity,
  detectPackageManager,
  ensureAgentrc,
  ensureGitignore,
  ensurePackageJson,
  GITIGNORE_BLOCKS,
  REQUIRED_NODE_FLOOR,
  SYNC_AGENTS_COMMAND,
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
    assert.equal(outcome.scriptsSyncAgents, 'added');
    assert.equal(outcome.scriptsPrepare, 'added');
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(pkg.scripts['sync:commands'], SYNC_COMMAND);
    assert.equal(pkg.scripts['sync:agents'], SYNC_AGENTS_COMMAND);
    // Both projections run on prepare — command tree AND role-scoped agents.
    assert.equal(
      pkg.scripts.prepare,
      `${SYNC_COMMAND} && ${SYNC_AGENTS_COMMAND}`,
    );
  });

  it('never seeds framework runtime deps into the consumer manifest', () => {
    // Story #3466: the dependency-merge loop was removed — framework deps
    // arrive transitively via mandrel, so bootstrap must leave the
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
    assert.equal(
      pkg.scripts.prepare,
      `husky && ${SYNC_COMMAND} && ${SYNC_AGENTS_COMMAND}`,
    );
  });

  it('appends only the agent sync to a prepare that already carries the command sync', () => {
    writeFile(
      path.join(tmpRoot, 'package.json'),
      `${JSON.stringify({ name: 'host', scripts: { prepare: `husky && ${SYNC_COMMAND}` } }, null, 2)}\n`,
    );
    const outcome = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(outcome.scriptsPrepare, 'appended');
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(
      pkg.scripts.prepare,
      `husky && ${SYNC_COMMAND} && ${SYNC_AGENTS_COMMAND}`,
    );
  });

  it('is idempotent on the second run', () => {
    ensurePackageJson({ projectRoot: tmpRoot });
    const second = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(second.created, false);
    assert.equal(second.scriptsSyncCommands, 'already-present');
    assert.equal(second.scriptsSyncAgents, 'already-present');
    assert.equal(second.scriptsPrepare, 'already-present');
    assert.equal(second.mutated, false);
  });
});

describe('ensureGitignore', () => {
  it('creates a fresh .gitignore with every secret-bearing block', () => {
    const outcome = ensureGitignore({ projectRoot: tmpRoot });
    assert.equal(outcome.commands, 'added');
    assert.equal(outcome.mcp, 'added');
    assert.equal(outcome.env, 'added');
    assert.equal(outcome.installLedger, 'added');
    const body = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    // The flat .claude/commands/ tree is the ignored generated path.
    assert.ok(body.includes('.claude/commands/'));
    assert.ok(body.includes('.mcp.json'));
    // Story #3894: .env (secrets) and the install ledger are now ignored.
    assert.ok(/^\.env$/m.test(body));
    assert.ok(body.includes(LEDGER_RELATIVE_PATH));
  });

  it('skips already-present entries (idempotent re-run adds nothing)', () => {
    writeFile(
      path.join(tmpRoot, '.gitignore'),
      `node_modules/\n.claude/commands/\n.mcp.json\n.env\n${LEDGER_RELATIVE_PATH}\n`,
    );
    const outcome = ensureGitignore({ projectRoot: tmpRoot });
    assert.equal(outcome.commands, 'already-present');
    assert.equal(outcome.mcp, 'already-present');
    assert.equal(outcome.env, 'already-present');
    assert.equal(outcome.installLedger, 'already-present');
  });

  it('is idempotent across two writes — no duplicate blocks (marker-keyed)', () => {
    ensureGitignore({ projectRoot: tmpRoot });
    const first = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    const second = ensureGitignore({ projectRoot: tmpRoot });
    const after = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    assert.equal(after, first);
    for (const key of Object.keys(GITIGNORE_BLOCKS)) {
      assert.equal(second[key], 'already-present');
    }
    // Exactly one occurrence of each ignored path.
    assert.equal((after.match(/^\.env$/gm) ?? []).length, 1);
    assert.equal((after.match(/^\.mcp\.json$/gm) ?? []).length, 1);
  });

  it('does not treat a pre-existing .env.example as the .env block', () => {
    // .env.example is the committed placeholder — it must NOT satisfy the
    // .env presence pattern, so the bare .env block is still added.
    writeFile(path.join(tmpRoot, '.gitignore'), '.env.example\n');
    const outcome = ensureGitignore({ projectRoot: tmpRoot });
    assert.equal(outcome.env, 'added');
    const body = fs.readFileSync(path.join(tmpRoot, '.gitignore'), 'utf8');
    assert.ok(/^\.env$/m.test(body));
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

describe('checkParity — command:false workflows', () => {
  function seed({ commandFalse = true, withCommand = true } = {}) {
    const wf = path.join(tmpRoot, '.agents', 'workflows');
    const cmd = path.join(tmpRoot, '.claude', 'commands');
    // A normal projectable workflow + its generated command.
    writeFile(
      path.join(wf, 'plan.md'),
      '---\ndescription: Plan\n---\n# Plan\n',
    );
    writeFile(path.join(cmd, 'plan.md'), '# Plan\n');
    // A lens workflow that declines a command via frontmatter.
    writeFile(
      path.join(wf, 'audit-lighthouse.md'),
      `---\ndescription: Lighthouse lens\n${commandFalse ? 'command: false\n' : ''}---\n# Lighthouse\n`,
    );
    // Optionally give it a command too (the caller controls the failing case).
    if (withCommand) {
      writeFile(path.join(cmd, 'audit-lighthouse.md'), '# Lighthouse\n');
    }
  }

  it('does not report a command:false workflow as missing a command', () => {
    // The Install Matrix cold-start regression: audit-lighthouse /
    // audit-security carry `command: false`, sync-claude-commands skips them,
    // and the parity check must skip them too rather than demand a command
    // the sync is contracted never to emit.
    seed({ commandFalse: true, withCommand: false });
    const result = checkParity({ projectRoot: tmpRoot });
    assert.equal(
      result.ok,
      true,
      'command:false workflow must not fail parity',
    );
    assert.deepEqual(result.missingCommand, []);
    assert.deepEqual(result.orphanCommand, []);
  });

  it('still flags a projectable workflow that is genuinely missing its command', () => {
    // Guard against over-correcting: a normal workflow with no command is a
    // real drift the check must keep catching.
    seed({ commandFalse: false, withCommand: false });
    const result = checkParity({ projectRoot: tmpRoot });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingCommand, ['audit-lighthouse']);
  });
});
