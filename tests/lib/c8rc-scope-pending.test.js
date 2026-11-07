import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { getPostSeatChecks } from '../../.agents/scripts/lib/config/handoff.js';
import { pendingSeatFiles } from '../helpers/c8rc-scope-pending.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NEW_FILE = '.agents/scripts/lib/new-file.js';

function recordingDiff(output) {
  const calls = [];
  const gitDiff = (baseRef, cwd) => {
    calls.push({ baseRef, cwd });
    return output;
  };
  return { calls, gitDiff };
}

describe('pendingSeatFiles', () => {
  test('names the merge-base diff while the handoff is in credited-run', () => {
    const { calls, gitDiff } = recordingDiff(
      `${NEW_FILE}\r\ntests/x.test.js\n`,
    );
    const files = pendingSeatFiles({
      env: { MANDREL_HANDOFF_STEP: 'credited-run' },
      baseBranch: 'trunk',
      cwd: '/repo',
      gitDiff,
    });
    assert.deepEqual([...files], [NEW_FILE, 'tests/x.test.js']);
    assert.deepEqual(calls, [{ baseRef: 'origin/trunk', cwd: '/repo' }]);
  });

  test('defaults the base branch to main', () => {
    const { calls, gitDiff } = recordingDiff('');
    pendingSeatFiles({
      env: { MANDREL_HANDOFF_STEP: 'credited-run' },
      gitDiff,
    });
    assert.equal(calls[0].baseRef, 'origin/main');
  });

  test('normalises Windows separators to the scope test path form', () => {
    const { gitDiff } = recordingDiff('.agents\\scripts\\lib\\new-file.js\n');
    const files = pendingSeatFiles({
      env: { MANDREL_HANDOFF_STEP: 'credited-run' },
      gitDiff,
    });
    assert.ok(files.has(NEW_FILE));
  });

  for (const step of [undefined, 'preflight', 'seat', 'post-capture']) {
    test(`is empty and runs no diff when the step is ${step ?? 'unset'}`, () => {
      const { calls, gitDiff } = recordingDiff(NEW_FILE);
      const env = step ? { MANDREL_HANDOFF_STEP: step } : {};
      assert.equal(pendingSeatFiles({ env, gitDiff }).size, 0);
      assert.equal(calls.length, 0);
    });
  }

  test('fails closed to empty when the diff fails', () => {
    const files = pendingSeatFiles({
      env: { MANDREL_HANDOFF_STEP: 'credited-run' },
      gitDiff: () => {
        throw new Error('unknown revision origin/main');
      },
    });
    assert.equal(files.size, 0);
  });
});

describe('.agentrc.json re-runs the scope test after the seat', () => {
  test('postSeatChecks declares a strict c8rc-scope run', () => {
    const agentrc = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, '.agentrc.json'), 'utf8'),
    );
    assert.deepEqual(getPostSeatChecks(agentrc), [
      { cmd: 'node', args: ['--test', 'tests/c8rc-scope.test.js'] },
    ]);
  });
});
