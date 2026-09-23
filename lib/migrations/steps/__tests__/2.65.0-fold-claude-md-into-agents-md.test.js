/**
 * Unit tests for the Story #5410 migration step — folds a root CLAUDE.md into
 * AGENTS.md per the shared fold contract and deletes CLAUDE.md.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  foldClaudeMdIntoAgentsMd,
  SYSTEM_PROMPT_IMPORT,
} from '../../../../.agents/scripts/lib/bootstrap/agents-md-fold.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';
import { migrations } from '../../index.js';
import { foldClaudeMdIntoAgentsMdStep as step } from '../2.65.0-fold-claude-md-into-agents-md.js';

let root;
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const write = (name, body) => fs.writeFileSync(path.join(root, name), body);
const count = (text, needle) =>
  text.split('\n').filter((l) => l.trim() === needle).length;

beforeEach(() => {
  root = makeTempDir('fold-claude-md-');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('2.65.0 fold-claude-md-into-agents-md', () => {
  it('is registered last, in ascending version order', () => {
    assert.equal(migrations.at(-1), step);
    assert.equal(step.version, '2.65.0');
  });

  it('detect is false when no CLAUDE.md exists', () => {
    write('AGENTS.md', '# a\n');
    assert.equal(step.detect({ projectRoot: root }), false);
  });

  it('AGENTS.md absent: CLAUDE.md content becomes AGENTS.md', () => {
    write('CLAUDE.md', `# Rules\n\n${SYSTEM_PROMPT_IMPORT}\n`);
    assert.equal(step.detect({ projectRoot: root }), true);
    step.apply({ projectRoot: root });
    assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
    assert.equal(read('AGENTS.md'), `# Rules\n\n${SYSTEM_PROMPT_IMPORT}\n`);
  });

  it('AGENTS.md present: appends CLAUDE.md after a blank line, drops @AGENTS.md, adds the import once', () => {
    write('AGENTS.md', '# Repo orientation\n');
    write('CLAUDE.md', '@AGENTS.md\n\n# Local notes\n');
    step.apply({ projectRoot: root });
    const body = read('AGENTS.md');
    assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
    assert.ok(body.startsWith('# Repo orientation\n\n'));
    assert.ok(body.includes('# Local notes'));
    assert.ok(!body.includes('@AGENTS.md'));
    assert.equal(count(body, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('keeps a single import when both files already carry it', () => {
    write('AGENTS.md', `${SYSTEM_PROMPT_IMPORT}\n`);
    write('CLAUDE.md', `# x\n${SYSTEM_PROMPT_IMPORT}\n`);
    step.apply({ projectRoot: root });
    assert.equal(count(read('AGENTS.md'), SYSTEM_PROMPT_IMPORT), 1);
  });

  it('a second pass is a no-op', () => {
    write('CLAUDE.md', '# only\n');
    step.apply({ projectRoot: root });
    const after = read('AGENTS.md');
    assert.equal(step.detect({ projectRoot: root }), false);
    assert.equal(read('AGENTS.md'), after);
  });
});

describe('foldClaudeMdIntoAgentsMd', () => {
  const fold = (claude) => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), claude);
    foldClaudeMdIntoAgentsMd(root);
    return read('AGENTS.md');
  };

  it('an empty CLAUDE.md with no AGENTS.md yields the install template', () => {
    const out = fold('@AGENTS.md\n');
    assert.equal(count(out, SYSTEM_PROMPT_IMPORT), 1);
    assert.ok(out.startsWith('# Agent Protocols'));
  });

  it('preserves operator content verbatim', () => {
    const claude = `# A\n  indented line  \n${SYSTEM_PROMPT_IMPORT}\n`;
    assert.equal(fold(claude), claude);
  });
});
