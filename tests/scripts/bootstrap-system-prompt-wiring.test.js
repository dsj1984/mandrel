/**
 * bootstrap-system-prompt-wiring.test — Story #3376
 *
 * Covers two bootstrap concerns that remove the silent manual activation
 * step for cold-start onboarding:
 *
 *   1. `ensureSystemPromptWiring` — creates / appends / no-ops the
 *      `@.agents/instructions.md` import inside a consumer `AGENTS.md` (folding any `CLAUDE.md`),
 *      keyed off the literal import path so a re-run never duplicates it.
 *   2. `ensurePackageJson` — seeds a discoverable `bootstrap` npm script
 *      when absent, and never overwrites an operator-defined one.
 *
 * Each helper must be idempotent: a second run on unchanged input mutates
 * nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BOOTSTRAP_COMMAND,
  BOOTSTRAP_PHASES,
  ensurePackageJson,
  ensureSystemPromptWiring,
  SYSTEM_PROMPT_IMPORT,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

let tmpRoot;

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  tmpRoot = makeTempDir('system-prompt-wiring-');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureSystemPromptWiring', () => {
  const agents = () => path.join(tmpRoot, 'AGENTS.md');
  const claude = () => path.join(tmpRoot, 'CLAUDE.md');
  const readAgents = () => fs.readFileSync(agents(), 'utf8');

  it('creates an AGENTS.md carrying the import and no CLAUDE.md on a fresh project', () => {
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'created');
    assert.equal(countOccurrences(readAgents(), SYSTEM_PROMPT_IMPORT), 1);
    assert.equal(fs.existsSync(claude()), false);
  });

  it('appends the import block when AGENTS.md exists without it', () => {
    writeFile(agents(), '# My Project\n\nSome existing operator notes.\n');
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'appended');
    const body = readAgents();
    assert.ok(body.includes('Some existing operator notes.'));
    assert.equal(countOccurrences(body, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('inserts a newline separator when AGENTS.md lacks a trailing newline', () => {
    writeFile(agents(), '# No trailing newline');
    ensureSystemPromptWiring({ projectRoot: tmpRoot });
    const body = readAgents();
    assert.ok(body.startsWith('# No trailing newline\n'));
    assert.ok(body.includes(SYSTEM_PROMPT_IMPORT));
  });

  it('is a no-op on an already-wired AGENTS.md (no duplicate import line)', () => {
    ensureSystemPromptWiring({ projectRoot: tmpRoot });
    const afterFirst = readAgents();
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'already-present');
    assert.equal(readAgents(), afterFirst);
  });

  it('folds a CLAUDE.md into an absent AGENTS.md and deletes CLAUDE.md', () => {
    writeFile(claude(), '# My Project\n\nOperator notes.\n');
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'folded');
    assert.equal(fs.existsSync(claude()), false);
    const body = readAgents();
    assert.ok(body.startsWith('# My Project\n\nOperator notes.\n'));
    assert.equal(countOccurrences(body, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('folds CLAUDE.md after an existing AGENTS.md, dropping its @AGENTS.md line', () => {
    writeFile(agents(), '# Orientation\n');
    writeFile(claude(), '@AGENTS.md\n\n# Extra\n');
    ensureSystemPromptWiring({ projectRoot: tmpRoot });
    const body = readAgents();
    assert.equal(fs.existsSync(claude()), false);
    assert.ok(body.startsWith('# Orientation\n\n'));
    assert.ok(body.includes('# Extra'));
    assert.ok(!body.includes('@AGENTS.md'));
    assert.equal(countOccurrences(body, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('keeps a single import when CLAUDE.md already carries it', () => {
    writeFile(
      claude(),
      `# Custom\n\n## System Prompt\n\n${SYSTEM_PROMPT_IMPORT}\n\n## Other\n`,
    );
    ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(fs.existsSync(claude()), false);
    assert.equal(countOccurrences(readAgents(), SYSTEM_PROMPT_IMPORT), 1);
  });

  it('is registered in BOOTSTRAP_PHASES after validation (Story #4527/#4530: claudeSettings phase retired)', () => {
    const names = BOOTSTRAP_PHASES.map((p) => p.name);
    const idxValidation = names.indexOf('validation');
    const idxWiring = names.indexOf('systemPromptWiring');
    assert.ok(idxWiring !== -1, 'systemPromptWiring phase must be registered');
    assert.ok(idxValidation !== -1, 'validation phase must be registered');
    assert.ok(idxWiring > idxValidation, 'must run after validation');
  });
});

describe('ensurePackageJson — bootstrap npm alias', () => {
  it('adds the bootstrap script on a green-field package.json', () => {
    const outcome = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(outcome.scriptsBootstrap, 'added');
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(pkg.scripts.bootstrap, BOOTSTRAP_COMMAND);
  });

  it('never overwrites an operator-defined bootstrap script', () => {
    writeFile(
      path.join(tmpRoot, 'package.json'),
      `${JSON.stringify(
        { name: 'host', scripts: { bootstrap: 'my-own-setup.sh' } },
        null,
        2,
      )}\n`,
    );
    const outcome = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(outcome.scriptsBootstrap, 'already-present');
    const pkg = readJson(path.join(tmpRoot, 'package.json'));
    assert.equal(pkg.scripts.bootstrap, 'my-own-setup.sh');
  });

  it('is idempotent — second run reports already-present and mutates nothing', () => {
    ensurePackageJson({ projectRoot: tmpRoot });
    const second = ensurePackageJson({ projectRoot: tmpRoot });
    assert.equal(second.scriptsBootstrap, 'already-present');
    assert.equal(second.mutated, false);
  });
});
