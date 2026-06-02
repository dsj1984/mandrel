// tests/cli/partition.test.js
/**
 * Invariant test: enforces the lifecycle/runtime partition boundary.
 *
 * The partition rule (documented in docs/architecture.md §
 * "Lifecycle vs. Runtime partition boundary") states that lifecycle
 * scripts — those invoked only by human operators — must NOT be wired
 * into agent-facing surfaces such as `.claude/settings.json` hooks via
 * their bare `.agents/scripts/<name>` paths.
 *
 * This test asserts that the UserPromptSubmit hook in
 * `.claude/settings.json` does NOT contain the legacy bare invocation
 * `node .agents/scripts/sync-claude-commands.js`, confirming that the
 * hook migration from Story #3451 has taken effect and the lifecycle
 * script is now correctly routed through the mandrel CLI.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');

/** Collect every `command` string from UserPromptSubmit hooks. */
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

describe('partition — lifecycle/runtime boundary invariant', () => {
  let settings;

  it('reads .claude/settings.json without error', () => {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    settings = JSON.parse(raw);
    assert.ok(settings, '.claude/settings.json must be valid JSON');
  });

  it('UserPromptSubmit hook does NOT contain the bare lifecycle script path', () => {
    // The bare invocation `node .agents/scripts/sync-claude-commands.js`
    // is a lifecycle path that must not appear in agent-facing hooks.
    // Story #3451 migrated this to `node bin/mandrel.js sync-commands`.
    const commands = getUserPromptSubmitCommands(settings);
    assert.ok(
      commands.length > 0,
      'Expected at least one UserPromptSubmit hook command to be present',
    );
    for (const cmd of commands) {
      assert.ok(
        !cmd.includes('node .agents/scripts/sync-claude-commands.js'),
        `Partition boundary violation: UserPromptSubmit hook must not invoke ` +
          `the bare lifecycle script at .agents/scripts/sync-claude-commands.js. ` +
          `Use the mandrel CLI instead (e.g. "node bin/mandrel.js sync-commands"). ` +
          `Got: ${cmd}`,
      );
    }
  });
});
