/**
 * sync-claude-commands frontmatter pass-through (Story #1324, Epic #1185).
 *
 * Asserts that the sync script propagates the optional `recommendedModel`
 * and `dispatchModel` fields verbatim, and that a workflow with neither
 * field set produces output that is byte-identical to today's baseline
 * (HEADER + source bytes). Together this proves the plumbing layer needs
 * no code change beyond the env-var SRC/DEST overrides added for testing.
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

test('sync-claude-commands: preserves recommendedModel + dispatchModel verbatim', () => {
  const source = [
    '---',
    'description: Fixture workflow with both model hint fields.',
    'recommendedModel: opus',
    'dispatchModel: haiku',
    '---',
    '',
    '# Fixture',
    '',
    'Body content.',
    '',
  ].join('\n');

  const synced = runSyncWith({ 'fixture-both.md': source });

  assert.ok(synced['fixture-both.md'], 'expected fixture-both.md in dest');
  // Header is prepended verbatim and frontmatter survives byte-for-byte.
  assert.equal(synced['fixture-both.md'], HEADER + source);
  // Defensive: both new fields are present in the synced output.
  assert.match(synced['fixture-both.md'], /^recommendedModel: opus$/m);
  assert.match(synced['fixture-both.md'], /^dispatchModel: haiku$/m);
});

test('sync-claude-commands: workflow without model hints is byte-identical to baseline', () => {
  // A workflow declaring only `description` represents the pre-Epic shape.
  // The synced output must equal HEADER + source bytes exactly — proof
  // that the plumbing layer's behaviour is unchanged for workflows that
  // opt out of the new convention.
  const source = [
    '---',
    'description: Fixture workflow with no model hints (pre-Epic shape).',
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
  // Confirm neither new field leaked in.
  assert.doesNotMatch(synced['fixture-baseline.md'], /recommendedModel/);
  assert.doesNotMatch(synced['fixture-baseline.md'], /dispatchModel/);
});

test('sync-claude-commands: each enum value round-trips for both fields', () => {
  const values = ['haiku', 'sonnet', 'opus'];
  const sources = {};
  for (const v of values) {
    sources[`fixture-${v}.md`] = [
      '---',
      `description: Fixture for ${v}.`,
      `recommendedModel: ${v}`,
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
