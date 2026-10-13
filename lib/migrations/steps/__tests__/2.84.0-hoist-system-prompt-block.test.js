/**
 * Unit tests for the Story #5655 migration step — moves an appended
 * system-prompt block to the top of AGENTS.md and upgrades it to carry the
 * prose read directive for hosts without `@`-import support.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  SYSTEM_PROMPT_BLOCK,
  SYSTEM_PROMPT_IMPORT,
} from '../../../../.agents/scripts/lib/bootstrap/agents-md-fold.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';
import { compareVersions, migrations } from '../../index.js';
import { hoistSystemPromptBlockStep as step } from '../2.84.0-hoist-system-prompt-block.js';

/** The pre-2.84.0 block: the import alone. */
const LEGACY_SYSTEM_PROMPT_BLOCK = `## System Prompt\n\n${SYSTEM_PROMPT_IMPORT}\n`;

let root;
const read = () => fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const write = (body) => fs.writeFileSync(path.join(root, 'AGENTS.md'), body);
const count = (text, needle) => text.split(needle).length - 1;

beforeEach(() => {
  root = makeTempDir('hoist-system-prompt-');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('2.84.0 hoist-system-prompt-block', () => {
  it('is registered last, in ascending version order', () => {
    const i = migrations.indexOf(step);
    assert.ok(i >= 0, 'registered');
    assert.equal(step.version, '2.84.0');
    const prev = migrations[i - 1];
    assert.ok(compareVersions(step.version, prev.version) > 0);
  });

  it('detect is false when AGENTS.md is absent', () => {
    assert.equal(step.detect({ projectRoot: root }), false);
    step.apply({ projectRoot: root });
    assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  });

  it('detect is false when AGENTS.md carries no recognizable block', () => {
    write(`# Custom\n\nnotes\n\n${SYSTEM_PROMPT_IMPORT}\n`);
    assert.equal(step.detect({ projectRoot: root }), false);
  });

  it('moves an appended legacy block to the top after the H1 and upgrades it', () => {
    const long = 'operator line\n'.repeat(50);
    write(`# Project\n\n${long}\n${LEGACY_SYSTEM_PROMPT_BLOCK}`);
    assert.equal(step.detect({ projectRoot: root }), true);
    step.apply({ projectRoot: root });
    const body = read();
    assert.ok(body.startsWith(`# Project\n\n${SYSTEM_PROMPT_BLOCK}\n`));
    assert.equal(count(body, SYSTEM_PROMPT_IMPORT), 1);
    assert.equal(count(body, 'operator line\n'), 50);
    assert.ok(body.endsWith('operator line\n'));
  });

  it('keeps operator sections that followed the appended block', () => {
    write(`# P\n\nintro\n\n${LEGACY_SYSTEM_PROMPT_BLOCK}\n## Mine\n\nkeep\n`);
    step.apply({ projectRoot: root });
    const body = read();
    assert.ok(body.startsWith(`# P\n\n${SYSTEM_PROMPT_BLOCK}\nintro\n`));
    assert.ok(body.endsWith('## Mine\n\nkeep\n'));
  });

  it('upgrades a legacy block that is already at the top', () => {
    write(`# P\n\n${LEGACY_SYSTEM_PROMPT_BLOCK}\nbody\n`);
    assert.equal(step.detect({ projectRoot: root }), true);
    step.apply({ projectRoot: root });
    assert.equal(read(), `# P\n\n${SYSTEM_PROMPT_BLOCK}\nbody\n`);
  });

  it('a file with no H1 gets the block on line 1', () => {
    write(`notes\n\n${SYSTEM_PROMPT_BLOCK}`);
    step.apply({ projectRoot: root });
    assert.ok(read().startsWith(SYSTEM_PROMPT_BLOCK));
  });

  it('detect is false once the block is at the top, and a second pass is a no-op', () => {
    write(`# P\n\nx\n\n${LEGACY_SYSTEM_PROMPT_BLOCK}`);
    step.apply({ projectRoot: root });
    const after = read();
    assert.equal(step.detect({ projectRoot: root }), false);
    step.apply({ projectRoot: root });
    assert.equal(read(), after);
  });
});
