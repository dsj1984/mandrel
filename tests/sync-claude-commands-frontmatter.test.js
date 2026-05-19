/**
 * sync-claude-commands frontmatter pass-through (Story #1324, Epic #1185;
 * trimmed in Story #2590 after `recommendedModel` was removed).
 *
 * Asserts that the sync script propagates the optional `dispatchModel`
 * field verbatim, and that a workflow with no model hint produces output
 * that is byte-identical to today's baseline (HEADER + source bytes).
 * Together this proves the plumbing layer needs no code change beyond
 * the env-var SRC/DEST overrides added for testing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SYNC_SCRIPT = path.join(
  PROJECT_ROOT,
  '.agents',
  'scripts',
  'sync-claude-commands.js',
);

const HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

/**
 * Run sync-claude-commands.js with isolated SRC/DEST dirs. Returns the
 * map of synced filenames → final on-disk content.
 */
function runSyncWith(sources) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-commands-'));
  const src = path.join(tmp, 'workflows');
  const dest = path.join(tmp, 'commands');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const [name, content] of Object.entries(sources)) {
    fs.writeFileSync(path.join(src, name), content, 'utf8');
  }
  const result = spawnSync(process.execPath, [SYNC_SCRIPT], {
    env: {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: src,
      SYNC_CLAUDE_COMMANDS_DEST: dest,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `sync exited with ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  const synced = {};
  for (const f of fs.readdirSync(dest)) {
    synced[f] = fs.readFileSync(path.join(dest, f), 'utf8');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return synced;
}

test('sync-claude-commands: preserves dispatchModel verbatim', () => {
  const source = [
    '---',
    'description: Fixture workflow with a dispatchModel hint.',
    'dispatchModel: haiku',
    '---',
    '',
    '# Fixture',
    '',
    'Body content.',
    '',
  ].join('\n');

  const synced = runSyncWith({ 'fixture-dispatch.md': source });

  assert.ok(synced['fixture-dispatch.md'], 'expected fixture-dispatch.md');
  // Header is prepended verbatim and frontmatter survives byte-for-byte.
  assert.equal(synced['fixture-dispatch.md'], HEADER + source);
  assert.match(synced['fixture-dispatch.md'], /^dispatchModel: haiku$/m);
});

test('sync-claude-commands: workflow without model hints is byte-identical to baseline', () => {
  // A workflow declaring only `description` represents the post-#2590
  // baseline shape. The synced output must equal HEADER + source bytes
  // exactly — proof that the plumbing layer's behaviour is unchanged for
  // workflows that opt out of the convention.
  const source = [
    '---',
    'description: Fixture workflow with no model hints (baseline shape).',
    '---',
    '',
    '# Baseline',
    '',
    'Body content.',
    '',
  ].join('\n');

  const synced = runSyncWith({ 'fixture-baseline.md': source });

  assert.ok(synced['fixture-baseline.md'], 'expected fixture-baseline.md');
  assert.equal(synced['fixture-baseline.md'], HEADER + source);
  // Confirm no model hint leaked in.
  assert.doesNotMatch(synced['fixture-baseline.md'], /dispatchModel/);
});

test('sync-claude-commands: each enum value round-trips for dispatchModel', () => {
  const values = ['haiku', 'sonnet', 'opus'];
  const sources = {};
  for (const v of values) {
    sources[`fixture-${v}.md`] = [
      '---',
      `description: Fixture for ${v}.`,
      `dispatchModel: ${v}`,
      '---',
      '',
      'Body.',
      '',
    ].join('\n');
  }
  const synced = runSyncWith(sources);
  for (const v of values) {
    const name = `fixture-${v}.md`;
    assert.ok(synced[name], `expected ${name} in dest`);
    assert.equal(synced[name], HEADER + sources[name]);
  }
});
