// tests/cli/hook-migration.test.js
/**
 * Contract test: .claude/settings.json UserPromptSubmit hook points at the
 * mandrel CLI, not at the old bare script path.
 *
 * AC coverage (Story #3451):
 *   1. The UserPromptSubmit hook command does NOT contain the legacy bare
 *      invocation "node .agents/scripts/sync-claude-commands.js".
 *   2. The UserPromptSubmit hook command DOES contain "mandrel" (the new
 *      CLI path).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');

function getUserPromptSubmitCommands(settings) {
  const hooks = settings?.hooks?.UserPromptSubmit ?? [];
  const commands = [];
  for (const entry of hooks) {
    for (const hook of entry.hooks ?? []) {
      if (hook.command) {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

describe('hook-migration — UserPromptSubmit hook uses mandrel CLI', () => {
  let settings;

  it('reads .claude/settings.json without error', () => {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    settings = JSON.parse(raw);
    assert.ok(settings, '.claude/settings.json must be valid JSON');
  });

  it('UserPromptSubmit hook does NOT contain the old bare script invocation', () => {
    const commands = getUserPromptSubmitCommands(settings);
    assert.ok(
      commands.length > 0,
      'Expected at least one UserPromptSubmit hook command',
    );
    for (const cmd of commands) {
      assert.ok(
        !cmd.includes('.agents/scripts/sync-claude-commands.js'),
        `UserPromptSubmit hook must not invoke the bare script path; got: ${cmd}`,
      );
    }
  });

  it('UserPromptSubmit hook command contains "mandrel" (the new CLI path)', () => {
    const commands = getUserPromptSubmitCommands(settings);
    const hasMandrel = commands.some((cmd) => cmd.includes('mandrel'));
    assert.ok(
      hasMandrel,
      `Expected at least one UserPromptSubmit hook command to reference "mandrel"; got: ${JSON.stringify(commands)}`,
    );
  });
});
