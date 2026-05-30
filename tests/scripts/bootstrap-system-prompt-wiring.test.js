/**
 * bootstrap-system-prompt-wiring.test — Story #3376
 *
 * Covers two bootstrap concerns that remove the silent manual activation
 * step for cold-start onboarding:
 *
 *   1. `ensureSystemPromptWiring` — creates / appends / no-ops the
 *      `@.agents/instructions.md` import inside a consumer `CLAUDE.md`,
 *      keyed off the literal import path so a re-run never duplicates it.
 *   2. `ensurePackageJson` — seeds a discoverable `bootstrap` npm script
 *      when absent, and never overwrites an operator-defined one.
 *
 * Each helper must be idempotent: a second run on unchanged input mutates
 * nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  BOOTSTRAP_COMMAND,
  BOOTSTRAP_PHASES,
  ensurePackageJson,
  ensureSystemPromptWiring,
  SYSTEM_PROMPT_IMPORT,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'system-prompt-wiring-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureSystemPromptWiring', () => {
  it('creates a CLAUDE.md carrying the import when none exists', () => {
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'created');
    const body = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf8');
    assert.ok(body.includes(SYSTEM_PROMPT_IMPORT));
    assert.equal(countOccurrences(body, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('appends the import block when CLAUDE.md exists without it', () => {
    writeFile(
      path.join(tmpRoot, 'CLAUDE.md'),
      '# My Project\n\nSome existing operator notes.\n',
    );
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'appended');
    const body = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf8');
    // Operator content is preserved.
    assert.ok(body.includes('Some existing operator notes.'));
    assert.ok(body.includes(SYSTEM_PROMPT_IMPORT));
    assert.equal(countOccurrences(body, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('inserts a newline separator when the existing file lacks a trailing newline', () => {
    writeFile(path.join(tmpRoot, 'CLAUDE.md'), '# No trailing newline');
    ensureSystemPromptWiring({ projectRoot: tmpRoot });
    const body = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf8');
    assert.ok(body.startsWith('# No trailing newline\n'));
    assert.ok(body.includes(SYSTEM_PROMPT_IMPORT));
  });

  it('is a no-op on an already-wired CLAUDE.md (no duplicate import line)', () => {
    // First run wires it.
    ensureSystemPromptWiring({ projectRoot: tmpRoot });
    const afterFirst = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf8');
    // Second run must not change a single byte.
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    const afterSecond = fs.readFileSync(
      path.join(tmpRoot, 'CLAUDE.md'),
      'utf8',
    );
    assert.equal(outcome.action, 'already-present');
    assert.equal(afterSecond, afterFirst);
    assert.equal(countOccurrences(afterSecond, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('recognises the import inside an operator-authored CLAUDE.md and does not duplicate it', () => {
    writeFile(
      path.join(tmpRoot, 'CLAUDE.md'),
      `# Custom\n\n## System Prompt\n\n${SYSTEM_PROMPT_IMPORT}\n\n## Other\n`,
    );
    const outcome = ensureSystemPromptWiring({ projectRoot: tmpRoot });
    assert.equal(outcome.action, 'already-present');
    const body = fs.readFileSync(path.join(tmpRoot, 'CLAUDE.md'), 'utf8');
    assert.equal(countOccurrences(body, SYSTEM_PROMPT_IMPORT), 1);
  });

  it('is registered in BOOTSTRAP_PHASES after claudeSettings', () => {
    const names = BOOTSTRAP_PHASES.map((p) => p.name);
    const idxSettings = names.indexOf('claudeSettings');
    const idxWiring = names.indexOf('systemPromptWiring');
    assert.ok(idxWiring !== -1, 'systemPromptWiring phase must be registered');
    assert.ok(idxWiring > idxSettings, 'must run after claudeSettings');
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
