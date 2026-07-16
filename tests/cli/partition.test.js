// tests/cli/partition.test.js
/**
 * Invariant test: enforces the lifecycle/runtime partition boundary.
 *
 * The partition rule (documented in docs/architecture.md §
 * "Lifecycle vs. Runtime partition boundary") states that lifecycle
 * scripts — those invoked only by human operators, exposed as `mandrel`
 * CLI subcommands — must NOT be wired into agent-facing surfaces such as
 * `.claude/settings.json` hooks via their bare `.agents/scripts/<name>`
 * path.
 *
 * Story #4527/#4530: this test originally checked only the
 * `UserPromptSubmit` hook, which has since been removed (it re-ran
 * `mandrel sync-commands` on every prompt, racing the harness's own read of
 * `.claude/commands/` mid-slash-command-expansion, and reported "0 file(s)
 * synced" on effectively every invocation — the real sync points already
 * cover every case: `prepare` on install, `mandrel sync`/`update` on
 * upgrade, doctor's `commands-in-sync`/`agents-in-sync` on hand-edits). The
 * invariant itself outlives that one hook: no hook event anywhere in
 * `.claude/settings.json` may bare-invoke a lifecycle script. This scans
 * every hook event (`PreToolUse`, `PostToolUse`, and any future addition),
 * not one specific key, so the check survives future hook wiring changes
 * the way the retired narrow version did not.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');

/**
 * Lifecycle scripts that must never be bare-invoked from a hook — each has
 * a `mandrel` CLI subcommand and must route through it
 * (docs/architecture.md § Lifecycle vs. Runtime partition boundary).
 */
const LIFECYCLE_SCRIPT_BASENAMES = [
  'sync-claude-commands.js',
  'sync-claude-agents.js',
];

/**
 * Collect every `command` string from every hook event in `settings.hooks`
 * (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, or any future addition)
 * — not just one specific event key.
 *
 * @param {object} settings
 * @returns {string[]}
 */
function getAllHookCommands(settings) {
  const hooks = settings?.hooks ?? {};
  const commands = [];
  for (const eventGroups of Object.values(hooks)) {
    for (const entry of eventGroups ?? []) {
      for (const hook of entry.hooks ?? []) {
        if (hook.command) commands.push(hook.command);
      }
    }
  }
  return commands;
}

describe('partition — lifecycle/runtime boundary invariant', () => {
  it('reads .claude/settings.json without error', () => {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    assert.ok(settings, '.claude/settings.json must be valid JSON');
  });

  it('no hook event bare-invokes a lifecycle script', () => {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const commands = getAllHookCommands(settings);
    for (const cmd of commands) {
      for (const basename of LIFECYCLE_SCRIPT_BASENAMES) {
        assert.ok(
          !cmd.includes(`.agents/scripts/${basename}`),
          `Partition boundary violation: a hook must not bare-invoke the ` +
            `lifecycle script ${basename}. Route through the mandrel CLI ` +
            `instead. Got: ${cmd}`,
        );
      }
    }
  });

  it('the per-prompt UserPromptSubmit re-sync hook is no longer wired (Story #4527/#4530)', () => {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    assert.equal(
      settings?.hooks?.UserPromptSubmit,
      undefined,
      'the per-prompt re-sync hook must not be wired — it races the ' +
        "harness's own read of .claude/commands/ and reports 0 file(s) " +
        'synced on effectively every invocation',
    );
  });
});
