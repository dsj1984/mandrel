/**
 * sync-claude-commands flat projection (Story #1324, Epic #1185; trimmed in
 * Story #2590; plugin cutover #3576 reverted back to flat /<name> commands).
 *
 * The writer projects each top-level workflow into a flat `.claude/commands/`
 * tree so it is invocable as a bare `/<name>` slash command (no plugin, no
 * marketplace). These tests assert the flat shape:
 *   - commands land at `<dest>/<name>.md`, frontmatter (`description:` /
 *     `dispatchModel:`) preserved verbatim with the AUTO-GENERATED header
 *     injected AFTER the frontmatter (so the `---` block stays on line 1);
 *   - `helpers/` is excluded;
 *   - re-running is idempotent (byte-identical output, no churn).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyHeader } from '../.agents/scripts/lib/command-header.js';

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
 * Run sync-claude-commands.js with an isolated SRC workflow tree and a flat
 * DEST commands dir. Returns the absolute commands-dir path plus a `commands`
 * map of synced filename → on-disk content. The caller owns cleanup.
 */
function runSyncWith(sources) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-commands-'));
  const src = path.join(tmp, 'workflows');
  const dest = path.join(tmp, '.claude', 'commands');
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
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `sync exited with ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  const commands = {};
  for (const f of fs.readdirSync(dest)) {
    commands[f] = fs.readFileSync(path.join(dest, f), 'utf8');
  }
  return {
    tmp,
    dest,
    commands,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('sync-claude-commands: preserves dispatchModel verbatim in the command', () => {
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

  const run = runSyncWith({ 'fixture-dispatch.md': source });
  try {
    assert.ok(
      run.commands['fixture-dispatch.md'],
      'expected fixture-dispatch.md',
    );
    // Frontmatter stays on line 1; the header is injected after the closing
    // `---`, and the frontmatter survives byte-for-byte.
    assert.ok(
      run.commands['fixture-dispatch.md'].startsWith('---\n'),
      'frontmatter must lead the file so Claude Code parses it',
    );
    assert.equal(
      run.commands['fixture-dispatch.md'],
      applyHeader(source, HEADER),
    );
    assert.match(
      run.commands['fixture-dispatch.md'],
      /^dispatchModel: haiku$/m,
    );
  } finally {
    run.cleanup();
  }
});

test('sync-claude-commands: command body is byte-identical to applyHeader(source)', () => {
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

  const run = runSyncWith({ 'fixture-baseline.md': source });
  try {
    assert.ok(
      run.commands['fixture-baseline.md'],
      'expected fixture-baseline.md',
    );
    assert.equal(
      run.commands['fixture-baseline.md'],
      applyHeader(source, HEADER),
    );
    assert.doesNotMatch(run.commands['fixture-baseline.md'], /dispatchModel/);
  } finally {
    run.cleanup();
  }
});

test('sync-claude-commands: excludes the helpers/ subdirectory', () => {
  const source = ['---', 'description: Fixture.', '---', '', 'Body.', ''].join(
    '\n',
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-commands-'));
  try {
    const src = path.join(tmp, 'workflows');
    const helpers = path.join(src, 'helpers');
    const dest = path.join(tmp, '.claude', 'commands');
    fs.mkdirSync(helpers, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, 'top-level.md'), source, 'utf8');
    // A helper module lives under helpers/ — it must NOT become a command.
    fs.writeFileSync(path.join(helpers, 'a-helper.md'), source, 'utf8');
    const result = spawnSync(process.execPath, [SYNC_SCRIPT], {
      env: {
        ...process.env,
        SYNC_CLAUDE_COMMANDS_SRC: src,
        SYNC_CLAUDE_COMMANDS_DEST: dest,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const synced = fs.readdirSync(dest).sort();
    assert.deepEqual(synced, ['top-level.md']);
    assert.equal(fs.existsSync(path.join(dest, 'a-helper.md')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync-claude-commands: re-running is idempotent (no churn)', () => {
  const source = ['---', 'description: Fixture.', '---', '', 'Body.', ''].join(
    '\n',
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-commands-'));
  try {
    const src = path.join(tmp, 'workflows');
    const dest = path.join(tmp, '.claude', 'commands');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, 'fixture.md'), source, 'utf8');
    const env = {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: src,
      SYNC_CLAUDE_COMMANDS_DEST: dest,
    };
    const first = spawnSync(process.execPath, [SYNC_SCRIPT], {
      env,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);
    const cmdPath = path.join(dest, 'fixture.md');
    const after1 = fs.readFileSync(cmdPath, 'utf8');
    const second = spawnSync(process.execPath, [SYNC_SCRIPT], {
      env,
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
    const after2 = fs.readFileSync(cmdPath, 'utf8');
    assert.equal(
      after1,
      after2,
      'second run leaves the command byte-identical',
    );
    // The second run reports zero newly-synced files.
    assert.match(second.stdout, /0 file\(s\) synced/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
