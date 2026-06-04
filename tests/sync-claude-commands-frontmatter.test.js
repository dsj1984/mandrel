/**
 * sync-claude-commands plugin projection (Story #1324, Epic #1185; trimmed in
 * Story #2590; cut over to the Claude Code plugin shape in Story #3576).
 *
 * The writer no longer emits a flat `.claude/commands/` tree — it projects the
 * workflows into a Claude Code **plugin** so each command is invocable as
 * `/mandrel:<name>`. These tests assert the plugin shape:
 *   - commands land under `<pluginRoot>/commands/<name>.md`, frontmatter
 *     (`description:` / `dispatchModel:`) preserved verbatim under the
 *     AUTO-GENERATED header;
 *   - the plugin manifest is written at
 *     `<pluginRoot>/.claude-plugin/plugin.json` with `name: "mandrel"`;
 *   - the repo-local marketplace listing is written one level above `plugins/`
 *     at `<marketplaceRoot>/.claude-plugin/marketplace.json`;
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
 * Run sync-claude-commands.js with an isolated SRC workflow tree and a DEST
 * plugin root. Returns the absolute plugin-root path plus a `commands` map of
 * synced filename → on-disk content. The caller owns cleanup via `cleanup()`.
 *
 * The DEST override points at the plugin root: the writer emits
 * `<dest>/commands/*.md`, `<dest>/.claude-plugin/plugin.json`, and the
 * marketplace two levels up at `<dest>/../../.claude-plugin/marketplace.json`.
 * We mirror the real `.claude/plugins/mandrel/` nesting so the marketplace path
 * resolves the same way it does in a project.
 */
function runSyncWith(sources) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-claude-commands-'));
  const src = path.join(tmp, 'workflows');
  // Nest the plugin root as <tmp>/.claude/plugins/mandrel so the writer's
  // "marketplace two levels up" math lands at <tmp>/.claude/.claude-plugin/.
  const pluginRoot = path.join(tmp, '.claude', 'plugins', 'mandrel');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const [name, content] of Object.entries(sources)) {
    fs.writeFileSync(path.join(src, name), content, 'utf8');
  }
  const result = spawnSync(process.execPath, [SYNC_SCRIPT], {
    env: {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: src,
      SYNC_CLAUDE_COMMANDS_DEST: pluginRoot,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `sync exited with ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  const commandsDir = path.join(pluginRoot, 'commands');
  const commands = {};
  for (const f of fs.readdirSync(commandsDir)) {
    commands[f] = fs.readFileSync(path.join(commandsDir, f), 'utf8');
  }
  return {
    tmp,
    pluginRoot,
    commands,
    manifestPath: path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    marketplacePath: path.join(
      tmp,
      '.claude',
      '.claude-plugin',
      'marketplace.json',
    ),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('sync-claude-commands: preserves dispatchModel verbatim in the plugin command', () => {
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
    // Header is prepended verbatim and frontmatter survives byte-for-byte.
    assert.equal(run.commands['fixture-dispatch.md'], HEADER + source);
    assert.match(
      run.commands['fixture-dispatch.md'],
      /^dispatchModel: haiku$/m,
    );
  } finally {
    run.cleanup();
  }
});

test('sync-claude-commands: workflow body is byte-identical to HEADER + source', () => {
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
    assert.equal(run.commands['fixture-baseline.md'], HEADER + source);
    assert.doesNotMatch(run.commands['fixture-baseline.md'], /dispatchModel/);
  } finally {
    run.cleanup();
  }
});

test('sync-claude-commands: emits a plugin manifest named "mandrel"', () => {
  const source = ['---', 'description: Fixture.', '---', '', 'Body.', ''].join(
    '\n',
  );
  const run = runSyncWith({ 'fixture.md': source });
  try {
    assert.ok(
      fs.existsSync(run.manifestPath),
      'expected .claude-plugin/plugin.json',
    );
    const manifest = JSON.parse(fs.readFileSync(run.manifestPath, 'utf8'));
    assert.equal(manifest.name, 'mandrel');
    assert.ok(
      typeof manifest.version === 'string' && manifest.version.length > 0,
      'manifest carries a version sourced from package.json',
    );
    assert.ok(
      typeof manifest.description === 'string' && manifest.description.length,
      'manifest carries a description',
    );
  } finally {
    run.cleanup();
  }
});

test('sync-claude-commands: emits a repo-local marketplace listing the mandrel plugin', () => {
  const source = ['---', 'description: Fixture.', '---', '', 'Body.', ''].join(
    '\n',
  );
  const run = runSyncWith({ 'fixture.md': source });
  try {
    assert.ok(
      fs.existsSync(run.marketplacePath),
      'expected .claude/.claude-plugin/marketplace.json',
    );
    const market = JSON.parse(fs.readFileSync(run.marketplacePath, 'utf8'));
    assert.equal(market.name, 'mandrel');
    assert.ok(Array.isArray(market.plugins) && market.plugins.length === 1);
    assert.equal(market.plugins[0].name, 'mandrel');
    // The plugin source resolves relative to the marketplace root (the dir
    // containing .claude-plugin/), so it points at ./plugins/mandrel.
    assert.equal(market.plugins[0].source, './plugins/mandrel');
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
    const pluginRoot = path.join(tmp, '.claude', 'plugins', 'mandrel');
    fs.mkdirSync(helpers, { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(src, 'top-level.md'), source, 'utf8');
    // A helper module lives under helpers/ — it must NOT become a command.
    fs.writeFileSync(path.join(helpers, 'a-helper.md'), source, 'utf8');
    const result = spawnSync(process.execPath, [SYNC_SCRIPT], {
      env: {
        ...process.env,
        SYNC_CLAUDE_COMMANDS_SRC: src,
        SYNC_CLAUDE_COMMANDS_DEST: pluginRoot,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const commandsDir = path.join(pluginRoot, 'commands');
    const synced = fs.readdirSync(commandsDir).sort();
    assert.deepEqual(synced, ['top-level.md']);
    assert.equal(fs.existsSync(path.join(commandsDir, 'a-helper.md')), false);
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
    const pluginRoot = path.join(tmp, '.claude', 'plugins', 'mandrel');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(src, 'fixture.md'), source, 'utf8');
    const env = {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: src,
      SYNC_CLAUDE_COMMANDS_DEST: pluginRoot,
    };
    const first = spawnSync(process.execPath, [SYNC_SCRIPT], {
      env,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);
    const cmdPath = path.join(pluginRoot, 'commands', 'fixture.md');
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
