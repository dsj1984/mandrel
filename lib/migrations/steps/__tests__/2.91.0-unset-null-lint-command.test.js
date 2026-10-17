// lib/migrations/steps/__tests__/2.91.0-unset-null-lint-command.test.js
/**
 * The 2.91.0 step drops an explicit `project.commands.lint: null` so a config
 * copied from the old reference keeps its lint gate. Unit tier: in-memory fs.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { unsetNullLintCommand as step } from '../2.91.0-unset-null-lint-command.js';

const ROOT = '/consumer';
const BASE = path.join(ROOT, '.agentrc.json');

function makeCtx(config) {
  const files = new Map();
  if (config !== null) files.set(BASE, JSON.stringify(config));
  const fs = {
    readFileSync(p) {
      if (!files.has(p))
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync(p, c) {
      files.set(p, c);
    },
  };
  return {
    ctx: { projectRoot: ROOT, fs },
    read: () => JSON.parse(files.get(BASE)),
  };
}

describe('2.91.0 unset-null-lint-command', () => {
  it('drops lint: null and keeps the other commands', () => {
    const { ctx, read } = makeCtx({
      project: { commands: { test: 'npm test', typecheck: null, lint: null } },
    });
    assert.equal(step.detect(ctx), true);
    step.apply(ctx);
    assert.deepEqual(read().project.commands, {
      test: 'npm test',
      typecheck: null,
    });
    assert.equal(step.detect(ctx), false);
  });

  it('leaves a configured lint, an absent key and a missing file alone', () => {
    assert.equal(
      step.detect(makeCtx({ project: { commands: { lint: 'eslint .' } } }).ctx),
      false,
    );
    assert.equal(step.detect(makeCtx({ project: {} }).ctx), false);
    assert.equal(step.detect(makeCtx(null).ctx), false);
  });
});
