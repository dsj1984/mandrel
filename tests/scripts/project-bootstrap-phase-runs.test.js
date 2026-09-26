/** Each BOOTSTRAP_PHASES `run`, driven against a hermetic scratch project. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  applyProjectBootstrap,
  BOOTSTRAP_PHASES,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const scratch = [];
afterEach(() => {
  while (scratch.length > 0) {
    fs.rmSync(scratch.pop(), { recursive: true, force: true });
  }
});

const phase = (name) => BOOTSTRAP_PHASES.find((p) => p.name === name);

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

describe('validation phase', () => {
  it('reports a missing schema module', async () => {
    const { projectRoot, agentRoot } = makeFixture({ schema: false });
    const res = await phase('validation').run({ projectRoot, agentRoot });
    assert.deepEqual(res, {
      ok: false,
      errors: ['config-settings-schema.js not found'],
    });
  });

  it('reports a missing .agentrc.json', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    const res = await phase('validation').run({ projectRoot, agentRoot });
    assert.deepEqual(res, { ok: false, errors: ['.agentrc.json missing'] });
  });

  it('passes a valid config and surfaces validator errors on an invalid one', async () => {
    const { projectRoot, agentRoot } = makeFixture();
    const rc = path.join(projectRoot, '.agentrc.json');
    write(rc, '{}');
    assert.deepEqual(
      await phase('validation').run({ projectRoot, agentRoot }),
      { ok: true, errors: [] },
    );
    write(rc, '{"bad":true}');
    const res = await phase('validation').run({ projectRoot, agentRoot });
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, [{ message: 'bad' }]);
  });
});

describe('sync phase', () => {
  it('runs both projections and joins their non-empty stdout', () => {
    const { projectRoot, agentRoot } = makeFixture();
    const { calls, spawnImpl } = recordingSpawn((args) => ({
      status: 0,
      stdout: args[0].endsWith('sync-claude-commands.js') ? ' cmds \n' : '',
    }));
    const res = phase('sync').run({ projectRoot, agentRoot, spawnImpl });
    assert.deepEqual(res, { ok: true, stdout: 'cmds' });
    assert.equal(calls.length, 2);
    assert.match(calls[0], /sync-claude-commands\.js$/);
    assert.match(calls[1], /sync-claude-agents\.js$/);
  });

  it('throws with the failing projection and its stderr', () => {
    const { projectRoot, agentRoot } = makeFixture();
    const { spawnImpl } = recordingSpawn({ status: 2, stderr: ' boom ' });
    assert.throws(
      () => phase('sync').run({ projectRoot, agentRoot, spawnImpl }),
      /sync-claude-commands\.js failed \(exit 2\): boom/,
    );
  });
});

describe('winPerf phase', () => {
  it('skips off Windows', () => {
    const res = phase('winPerf').run({ projectRoot: '/x', platform: 'linux' });
    assert.equal(res.skipped, true);
  });

  it('skips on Windows when the helper script is missing', () => {
    const { projectRoot, agentRoot } = makeFixture();
    const res = phase('winPerf').run({
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

  it('runs the helper on Windows and reports its exit and stdout', () => {
    const { projectRoot, agentRoot } = makeFixture();
    write(path.join(agentRoot, 'scripts', 'check-windows-git-perf.js'), '');
    const { calls, spawnImpl } = recordingSpawn({
      status: 1,
      stdout: ' hint ',
    });
    const res = phase('winPerf').run({
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
  it('skips issue forms and quality gates unless opted in', () => {
    assert.equal(
      phase('issueForms').run({}).reason,
      'issue-forms-not-opted-in',
    );
    assert.equal(phase('quality').run({}).reason, 'quality-not-opted-in');
  });

  it('materializes the issue forms when opted in', () => {
    const { projectRoot } = makeFixture();
    const res = phase('issueForms').run({ projectRoot, withIssueForms: true });
    assert.ok(res.story);
    assert.ok(fs.existsSync(res.story.path));
  });

  it('applies the quality bootstrap when opted in', () => {
    const { projectRoot } = makeFixture();
    const res = phase('quality').run({ projectRoot, withQuality: true });
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
    assert.deepEqual(
      Object.keys(report),
      BOOTSTRAP_PHASES.map((p) => p.name),
    );
    assert.equal(report.pkg.created, true);
    assert.equal(report.install.reason, 'already-installed');
    assert.equal(report.agentrc.action, 'seeded');
    assert.equal(report.validation.ok, true);
    assert.equal(report.parity.ok, true);
    assert.equal(report.winPerf.skipped, true);
    assert.equal(calls.length, 2);
  });
});
