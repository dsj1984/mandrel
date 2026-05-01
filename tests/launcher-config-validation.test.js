import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SCRIPTS = [
  {
    name: 'epic-runner',
    relPath: '.agents/scripts/epic-runner.js',
    args: ['--epic', '1'],
  },
  {
    name: 'epic-plan',
    relPath: '.agents/scripts/epic-plan.js',
    args: ['--epic', '1', '--prd', 'x', '--techspec', 'y', '--tickets', 'z'],
  },
  {
    name: 'epic-plan-spec',
    relPath: '.agents/scripts/epic-plan-spec.js',
    args: ['--epic', '1', '--emit-context'],
  },
  {
    name: 'epic-plan-decompose',
    relPath: '.agents/scripts/epic-plan-decompose.js',
    args: ['--epic', '1', '--emit-context'],
  },
];

function buildFixtureWithoutRequiredEpicRunnerField() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, '.agentrc.json'), 'utf8'),
  );
  // Schema requires orchestration.runners.epicRunner.concurrencyCap — drop it
  // to force a validation failure before any long-running flow begins.
  delete raw.orchestration.runners.epicRunner.concurrencyCap;
  return raw;
}

describe('launcher-level orchestration config validation', () => {
  let fixtureDir;

  before(() => {
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'launcher-config-validation-'),
    );
    fs.writeFileSync(
      path.join(fixtureDir, '.agentrc.json'),
      JSON.stringify(buildFixtureWithoutRequiredEpicRunnerField(), null, 2),
    );
  });

  after(() => {
    if (fixtureDir) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  for (const s of SCRIPTS) {
    test(`${s.name} exits non-zero with schema error when epicRunner.concurrencyCap is missing`, () => {
      const res = spawnSync(
        process.execPath,
        [path.join(PROJECT_ROOT, s.relPath), ...s.args],
        {
          encoding: 'utf8',
          cwd: PROJECT_ROOT,
          env: { ...process.env, AP_AGENTRC_CWD: fixtureDir, CI: '1' },
          timeout: 20_000,
        },
      );

      assert.notStrictEqual(
        res.status,
        0,
        `${s.name} should exit non-zero on schema drift. stdout=${res.stdout} stderr=${res.stderr}`,
      );

      const combined = `${res.stdout}\n${res.stderr}`;
      assert.match(
        combined,
        /schema validation failed|concurrencyCap|required property/i,
        `${s.name} should surface a schema error before any provider call. Got: ${combined}`,
      );
    });
  }
});
