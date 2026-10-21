/**
 * Each bootstrap phase, driven through `applyProjectBootstrap` against a
 * hermetic scratch project — plus the pipeline contract: canonical order,
 * the three fatal phases aborting the run, and `onlyPhases` selection.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { applyProjectBootstrap } from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const scratch = [];
afterEach(() => {
  while (scratch.length > 0) {
    fs.rmSync(scratch.pop(), { recursive: true, force: true });
  }
});

const CANONICAL_ORDER = [
  'nodeCheck',
  'pkg',
  'install',
  'agentrc',
  'validation',
  'systemPromptWiring',
  'gitignore',
  'issueForms',
  'sync',
  'parity',
  'quality',
  'winPerf',
];

/** One phase's result, driven through the public entry point. */
async function runPhase(name, ctx) {
  const report = await applyProjectBootstrap({ ...ctx, onlyPhases: [name] });
  return report[name];
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

const STUB_SCHEMA = `export function getAgentrcValidator() {
  const validate = (data) => {
    validate.errors = data.bad ? [{ message: 'bad' }] : null;
    return !data.bad;
  };
  return validate;
}
`;

function makeFixture({ schema = true } = {}) {
  const projectRoot = makeTempDir('pb-phase-project-');
  const agentRoot = makeTempDir('pb-phase-agents-');
  scratch.push(projectRoot, agentRoot);
  if (schema) {
    write(
      path.join(agentRoot, 'scripts', 'lib', 'config-settings-schema.js'),
      STUB_SCHEMA,
    );
  }
  fs.mkdirSync(path.join(agentRoot, 'workflows'), { recursive: true });
  return { projectRoot, agentRoot };
}

function recordingSpawn(result = { status: 0, stdout: '' }) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push([cmd, ...args].map((a) => path.basename(a)).join(' '));
    return typeof result === 'function' ? result(args) : result;
  };
  return { calls, spawnImpl };
}

describe('validation phase — fatal on any failure', () => {
  it('aborts on a missing schema module', async () => {
    const { projectRoot, agentRoot } = makeFixture({ schema: false });
    await assert.rejects(
      runPhase('validation', { projectRoot, agentRoot }),
      /\.agentrc\.json failed schema validation: \[\s*"config-settings-schema\.js not found"/,
    );
  });

  it('aborts on a missing .agentrc.json', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    await assert.rejects(
      runPhase('validation', { projectRoot, agentRoot }),
      /failed schema validation: \[\s*"\.agentrc\.json missing"/,
    );
  });

  it('passes a valid config and surfaces validator errors on an invalid one', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    const rc = path.join(projectRoot, '.agentrc.json');
    write(rc, '{}');
    assert.deepEqual(await runPhase('validation', { projectRoot, agentRoot }), {
      ok: true,
      errors: [],
    });
    write(rc, '{"bad":true}');
    await assert.rejects(
      runPhase('validation', { projectRoot, agentRoot }),
      /failed schema validation: \[\s*\{\s*"message": "bad"/,
    );
  });
});

describe('sync phase', () => {
  it('runs both projections and joins their non-empty stdout', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    const { calls, spawnImpl } = recordingSpawn((args) => ({
      status: 0,
      stdout: args[0].endsWith('sync-claude-commands.js') ? ' cmds \n' : '',
    }));
    const res = await runPhase('sync', { projectRoot, agentRoot, spawnImpl });
    assert.deepEqual(res, { ok: true, stdout: 'cmds' });
    assert.equal(calls.length, 2);
    assert.match(calls[0], /sync-claude-commands\.js$/);
    assert.match(calls[1], /sync-claude-agents\.js$/);
  });

  it('throws with the failing projection and its stderr', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    const { spawnImpl } = recordingSpawn({ status: 2, stderr: ' boom ' });
    await assert.rejects(
      runPhase('sync', { projectRoot, agentRoot, spawnImpl }),
      /sync-claude-commands\.js failed \(exit 2\): boom/,
    );
  });
});

describe('winPerf phase', () => {
  it('skips off Windows', async () => {
    const res = await runPhase('winPerf', {
      projectRoot: '/x',
      platform: 'linux',
    });
    assert.equal(res.skipped, true);
  });

  it('skips on Windows when the helper script is missing', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    const res = await runPhase('winPerf', {
      projectRoot,
      agentRoot,
      platform: 'win32',
    });
    assert.deepEqual(res, {
      platform: 'win32',
      skipped: true,
      reason: 'script-missing',
    });
  });

  it('runs the helper on Windows and reports its exit and stdout', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    write(path.join(agentRoot, 'scripts', 'check-windows-git-perf.js'), '');
    const { calls, spawnImpl } = recordingSpawn({
      status: 1,
      stdout: ' hint ',
    });
    const res = await runPhase('winPerf', {
      projectRoot,
      agentRoot,
      platform: 'win32',
      spawnImpl,
    });
    assert.deepEqual(res, {
      platform: 'win32',
      skipped: false,
      ok: false,
      stdout: 'hint',
    });
    assert.match(calls[0], /check-windows-git-perf\.js$/);
  });
});

describe('opt-in phases', () => {
  it('skips issue forms and quality gates unless opted in', async () => {
    assert.equal(
      (await runPhase('issueForms', {})).reason,
      'issue-forms-not-opted-in',
    );
    assert.equal(
      (await runPhase('quality', {})).reason,
      'quality-not-opted-in',
    );
  });

  it('materializes the issue forms when opted in', async () => {
    const { projectRoot } = makeFixture();
    const res = await runPhase('issueForms', {
      projectRoot,
      withIssueForms: true,
    });
    assert.ok(res.story);
    assert.ok(fs.existsSync(res.story.path));
  });

  it('applies the quality bootstrap when opted in', async () => {
    const { projectRoot } = makeFixture();
    const res = await runPhase('quality', { projectRoot, withQuality: true });
    assert.ok(res.hook);
    assert.ok(res.scripts);
  });
});

describe('applyProjectBootstrap — full pipeline on a scratch project', () => {
  it('runs every phase in order and lands each result on the report', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    write(path.join(agentRoot, 'starter-agentrc.json'), '{"owner":"[OWNER]"}');
    write(path.join(projectRoot, 'node_modules', 'ajv', 'package.json'), '{}');
    const { calls, spawnImpl } = recordingSpawn();
    const report = await applyProjectBootstrap({
      projectRoot,
      agentRoot,
      answers: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
      spawnImpl,
      platform: 'linux',
    });
    assert.deepEqual(Object.keys(report), CANONICAL_ORDER);
    assert.equal(report.pkg.created, true);
    assert.equal(report.install.reason, 'already-installed');
    assert.equal(report.agentrc.action, 'seeded');
    assert.equal(report.validation.ok, true);
    assert.equal(report.parity.ok, true);
    assert.equal(report.winPerf.skipped, true);
    assert.equal(calls.length, 2);
  });
});

describe('applyProjectBootstrap — pipeline contract', () => {
  it('aborts on a Node below the engines floor before any later phase runs', async () => {
    const { projectRoot } = makeFixture();
    await assert.rejects(
      applyProjectBootstrap({
        projectRoot,
        nodeVersion: '18.0.0',
        onlyPhases: ['nodeCheck', 'pkg'],
      }),
      /Node 18\.0\.0 is below required 22\.22\.1/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, 'package.json')), false);
  });

  it('a failed validation stops the phases after it', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    write(path.join(projectRoot, '.agentrc.json'), '{"bad":true}');
    await assert.rejects(
      applyProjectBootstrap({
        projectRoot,
        agentRoot,
        onlyPhases: ['validation', 'gitignore'],
      }),
      /failed schema validation/,
    );
    assert.equal(fs.existsSync(path.join(projectRoot, '.gitignore')), false);
  });

  it('a non-fatal phase reporting a failure does not stop the run', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    const report = await applyProjectBootstrap({
      projectRoot,
      agentRoot,
      answers: { owner: 'acme', repo: 'widget' },
      onlyPhases: ['agentrc', 'gitignore'],
    });
    assert.equal(report.agentrc.action, 'missing-starter');
    assert.equal(report.gitignore.env, 'added');
  });

  it('runs the selected phases in canonical order, whatever order they are named in', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    write(path.join(projectRoot, '.agentrc.json'), '{}');
    const report = await applyProjectBootstrap({
      projectRoot,
      agentRoot,
      onlyPhases: ['gitignore', 'validation', 'pkg'],
    });
    assert.deepEqual(Object.keys(report), ['pkg', 'validation', 'gitignore']);
    assert.equal(report.validation.ok, true);
  });
});
