/**
 * sync-claude-commands — local/workflows/ source (Story #4243)
 *
 * Verifies the prune-exempt second source directory:
 *   AC1. A file at .agents/local/workflows/foo.md projects to
 *        .claude/commands/foo.md (invocable as /foo).
 *   AC2. The projected command survives a second sync run (idempotent /
 *        prune-exempt: no "no longer in workflows" removal).
 *   AC3. A core payload command of the same basename wins; the local copy
 *        is ignored with a "shadowed" warning on stderr/stdout.
 *   AC4. Removing the local file removes its projected command on the next
 *        sync (still reaped when absent from both sources).
 *   AC5. The SYNC_CLAUDE_COMMANDS_SRC test override still works (existing
 *        fixture tests continue to pass; LOCAL_SRC remains absent or empty
 *        when the fixture tree has no local/workflows/).
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

const LOCAL_HEADER =
  '<!-- AUTO-GENERATED from .agents/local/ — do not edit. Source of truth: .agents/local/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

const PAYLOAD_HEADER =
  '<!-- AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/ -->\n<!-- Re-run: npm run sync:commands -->\n\n';

/**
 * Run sync-claude-commands.js with a fully isolated fixture tree.
 *
 * `options.payloadFiles`  — map of name→content to write under workflows/
 * `options.localFiles`    — map of name→content to write under local/workflows/
 * `options.existingDest`  — map of name→content to pre-populate .claude/commands/
 *
 * Returns { dest, result, commands, tmp, cleanup }.
 */
function runSyncIsolated({
  payloadFiles = {},
  localFiles = {},
  existingDest = {},
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-local-test-'));

  // Payload source (overridden via SYNC_CLAUDE_COMMANDS_SRC)
  const payloadSrc = path.join(tmp, 'workflows');
  fs.mkdirSync(payloadSrc, { recursive: true });
  for (const [name, content] of Object.entries(payloadFiles)) {
    fs.writeFileSync(path.join(payloadSrc, name), content, 'utf8');
  }

  // Local source — lives at <cwd>/.agents/local/workflows/ relative to the
  // project root that sync-claude-commands derives from process.cwd().
  // We set cwd to `tmp` and create the local/ tree there.
  const localSrc = path.join(tmp, '.agents', 'local', 'workflows');
  if (Object.keys(localFiles).length > 0) {
    fs.mkdirSync(localSrc, { recursive: true });
    for (const [name, content] of Object.entries(localFiles)) {
      fs.writeFileSync(path.join(localSrc, name), content, 'utf8');
    }
  }

  // Destination
  const dest = path.join(tmp, '.claude', 'commands');
  fs.mkdirSync(dest, { recursive: true });
  for (const [name, content] of Object.entries(existingDest)) {
    fs.writeFileSync(path.join(dest, name), content, 'utf8');
  }

  const result = spawnSync(process.execPath, [SYNC_SCRIPT], {
    cwd: tmp,
    env: {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: payloadSrc,
      SYNC_CLAUDE_COMMANDS_DEST: dest,
    },
    encoding: 'utf8',
  });

  const commands = {};
  for (const f of fs.readdirSync(dest)) {
    commands[f] = fs.readFileSync(path.join(dest, f), 'utf8');
  }

  return {
    dest,
    result,
    commands,
    tmp,
    localSrc,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// AC1: local file projects to commands/
// ---------------------------------------------------------------------------

test('AC1: .agents/local/workflows/foo.md projects to .claude/commands/foo.md', () => {
  const run = runSyncIsolated({
    localFiles: {
      'benchmark.md': '# /benchmark\n\nA durable consumer command.\n',
    },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.ok(
      run.commands['benchmark.md'],
      'benchmark.md should appear in .claude/commands/',
    );
    // Must carry the local header, not the payload header
    assert.ok(
      run.commands['benchmark.md'].includes(
        'AUTO-GENERATED from .agents/local/',
      ),
      'projected local command must carry the local-origin header',
    );
    assert.ok(
      run.commands['benchmark.md'].includes('A durable consumer command.'),
      'body content must be preserved',
    );
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2: projected command survives a re-run (prune-exempt)
// ---------------------------------------------------------------------------

test('AC2: local command survives a second sync run (prune-exempt)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-local-survive-'));
  try {
    const payloadSrc = path.join(tmp, 'workflows');
    fs.mkdirSync(payloadSrc, { recursive: true });

    const localSrc = path.join(tmp, '.agents', 'local', 'workflows');
    fs.mkdirSync(localSrc, { recursive: true });
    fs.writeFileSync(
      path.join(localSrc, 'my-command.md'),
      '# /my-command\n\nDurable.\n',
      'utf8',
    );

    const dest = path.join(tmp, '.claude', 'commands');
    fs.mkdirSync(dest, { recursive: true });

    const env = {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: payloadSrc,
      SYNC_CLAUDE_COMMANDS_DEST: dest,
    };

    // First run — projects the command
    const first = spawnSync(process.execPath, [SYNC_SCRIPT], {
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(
      fs.existsSync(path.join(dest, 'my-command.md')),
      'command must exist after first run',
    );

    // Second run — must not reap the command
    const second = spawnSync(process.execPath, [SYNC_SCRIPT], {
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
    assert.ok(
      fs.existsSync(path.join(dest, 'my-command.md')),
      'command must still exist after second run (prune-exempt)',
    );
    assert.doesNotMatch(
      second.stdout + second.stderr,
      /removed.*my-command/,
      'second run must not report the local command as removed',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC3: payload wins on collision; shadowed warning emitted
// ---------------------------------------------------------------------------

test('AC3: payload command wins when local has same basename; shadowed warning emitted', () => {
  const payloadContent = '# /deliver\n\nThis is the PAYLOAD deliver command.\n';
  const localContent = '# /deliver\n\nThis is the LOCAL deliver command.\n';

  const run = runSyncIsolated({
    payloadFiles: { 'deliver.md': payloadContent },
    localFiles: { 'deliver.md': localContent },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.ok(run.commands['deliver.md'], 'deliver.md must be projected');

    // Payload body must win
    assert.ok(
      run.commands['deliver.md'].includes('PAYLOAD deliver command'),
      'projected command must contain payload content, not local content',
    );
    assert.ok(
      !run.commands['deliver.md'].includes('LOCAL deliver command'),
      'local content must be suppressed when shadowed',
    );

    // A "shadowed" warning must be emitted (Logger.warn goes to stdout in
    // this project's Logger implementation)
    const combinedOutput = run.result.stdout + run.result.stderr;
    assert.match(
      combinedOutput,
      /shadowed.*deliver\.md|deliver\.md.*shadowed/i,
      'a shadowed warning must be logged for the collision',
    );
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4: removing local file removes its projected command on next sync
// ---------------------------------------------------------------------------

test('AC4: removing .agents/local/workflows/foo.md reaps .claude/commands/foo.md on next sync', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-local-reap-'));
  try {
    const payloadSrc = path.join(tmp, 'workflows');
    fs.mkdirSync(payloadSrc, { recursive: true });

    const localSrc = path.join(tmp, '.agents', 'local', 'workflows');
    fs.mkdirSync(localSrc, { recursive: true });
    fs.writeFileSync(
      path.join(localSrc, 'to-remove.md'),
      '# /to-remove\n',
      'utf8',
    );

    const dest = path.join(tmp, '.claude', 'commands');
    fs.mkdirSync(dest, { recursive: true });

    const env = {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: payloadSrc,
      SYNC_CLAUDE_COMMANDS_DEST: dest,
    };

    // First run — projects the command
    const first = spawnSync(process.execPath, [SYNC_SCRIPT], {
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(
      fs.existsSync(path.join(dest, 'to-remove.md')),
      'command must exist after first run',
    );

    // Delete the local source file
    fs.unlinkSync(path.join(localSrc, 'to-remove.md'));

    // Second run — must reap the now-orphaned command
    const second = spawnSync(process.execPath, [SYNC_SCRIPT], {
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      fs.existsSync(path.join(dest, 'to-remove.md')),
      false,
      'command must be reaped after its local source is deleted',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC5: SYNC_CLAUDE_COMMANDS_SRC override still works (existing fixture contract)
// ---------------------------------------------------------------------------

test('AC5: SYNC_CLAUDE_COMMANDS_SRC override still works; no local/ = no extra commands', () => {
  // When the cwd has no .agents/local/workflows/, LOCAL_SRC is silently skipped
  // and the behaviour is identical to the pre-#4243 single-source mode.
  const run = runSyncIsolated({
    payloadFiles: {
      'plan.md': '# /plan\n\nPayload-only command.\n',
    },
    // No localFiles — no .agents/local/workflows/ created
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const names = Object.keys(run.commands).sort();
    assert.deepEqual(
      names,
      ['plan.md'],
      'only the payload command should exist',
    );
    // Payload header must be applied (not local header)
    assert.ok(
      run.commands['plan.md'].includes(
        'AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/',
      ),
      'payload command must carry the standard payload header',
    );
    assert.ok(
      !run.commands['plan.md'].includes('AUTO-GENERATED from .agents/local/'),
      'payload command must not carry the local header',
    );
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Extra: local and payload commands coexist without interfering
// ---------------------------------------------------------------------------

test('local and payload commands coexist without interfering', () => {
  const run = runSyncIsolated({
    payloadFiles: {
      'deliver.md': '# /deliver\n\nPayload deliver.\n',
      'plan.md': '# /plan\n\nPayload plan.\n',
    },
    localFiles: {
      'benchmark.md': '# /benchmark\n\nLocal benchmark.\n',
    },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const names = Object.keys(run.commands).sort();
    assert.deepEqual(
      names,
      ['benchmark.md', 'deliver.md', 'plan.md'],
      'all three commands must be projected',
    );
    // benchmark uses local header; deliver + plan use payload header
    assert.ok(
      run.commands['benchmark.md'].includes(
        'AUTO-GENERATED from .agents/local/',
      ),
    );
    assert.ok(
      run.commands['deliver.md'].includes(
        'AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/',
      ),
    );
  } finally {
    run.cleanup();
  }
});
