/**
 * sync-claude-commands — loops/ namespaced projection (Story #4289, Epic #4284)
 *
 * Verifies the one recursed subdirectory exception to the flat-projection
 * rule. Loop units under `.agents/workflows/loops/` project to the
 * namespaced `.claude/commands/loops/<name>.md`, invocable as the
 * namespaced `/loops:<name>` command (flat fallback `/loops-<name>` on
 * hosts that flatten subdirectory commands — a host-side detail, not a
 * second on-disk copy). `helpers/` MUST stay unprojected.
 *
 *   AC1. A fixture loop unit at workflows/loops/<name>.md projects to
 *        .claude/commands/loops/<name>.md (subpath preserved →
 *        /loops:<name>).
 *   AC2. A fixture workflows/helpers/<name>.md is NOT projected — neither
 *        flat at the command root nor under loops/.
 *   AC3. The namespaced invocation form is /loops:<name>: the projected
 *        path is loops/<name>.md (subpath preserved into
 *        .claude/commands/loops/), and the body is preserved with the
 *        payload header. The flat fallback form is /loops-<name> (a
 *        host-side flattening of the same file), documented here and in
 *        the generated workflows catalog.
 *   AC4. A loop unit and a flat top-level command of the same basename
 *        coexist without collision (distinct destination-relative paths).
 *   AC5. Removing a loop unit reaps its namespaced command on the next
 *        sync, without touching unrelated flat commands.
 *
 * The fixture is fully self-owned (this Story ships no starter loops —
 * those arrive in a later Story), so the test never depends on the real
 * workflows tree.
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

// The flat-fallback invocation form a host that flattens subdirectory
// commands would surface for a loop unit named `<name>` (documented; the
// projection writes the namespaced path, not this flat copy).
const flatFallbackCommand = (name) => `/loops-${name}`;

// The namespaced invocation form Claude Code surfaces for a loop unit
// projected at `.claude/commands/loops/<name>.md`.
const namespacedCommand = (name) => `/loops:${name}`;

/**
 * Run sync-claude-commands.js against a fully isolated fixture tree.
 *
 * `options.payloadFiles`  — map of relative path → content under workflows/
 *                           (e.g. `'loops/foo.md'`, `'helpers/bar.md'`,
 *                           `'plan.md'`).
 * `options.existingDest`  — map of relative path → content under
 *                           .claude/commands/ to pre-populate.
 *
 * Returns { dest, result, commands, tmp, cleanup }. `commands` is a flat
 * map keyed by the destination-relative path (`loops/foo.md`, `plan.md`).
 */
function runSyncIsolated({ payloadFiles = {}, existingDest = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-loops-test-'));

  const payloadSrc = path.join(tmp, 'workflows');
  fs.mkdirSync(payloadSrc, { recursive: true });
  for (const [rel, content] of Object.entries(payloadFiles)) {
    const file = path.join(payloadSrc, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }

  const dest = path.join(tmp, '.claude', 'commands');
  fs.mkdirSync(dest, { recursive: true });
  for (const [rel, content] of Object.entries(existingDest)) {
    const file = path.join(dest, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
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
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.md')) {
        commands[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      }
    }
  };
  walk(dest, '');

  return {
    dest,
    result,
    commands,
    tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

const LOOP_UNIT = [
  '---',
  'description: A self-paced convergence loop fixture for the projection test.',
  'loop:',
  '  cadence: self-paced',
  '  goal: drive the working tree to a green lint run',
  '  verify: npm run lint',
  '  maxRounds: 5',
  '  onExhaust: report',
  '---',
  '',
  '# Loop fixture body',
  '',
  'This is the namespaced loop unit under test.',
  '',
].join('\n');

const HELPER_FILE = '# Path-included helper\n\nNot a slash command.\n';

// ---------------------------------------------------------------------------
// AC1: loop unit projects to .claude/commands/loops/<name>.md
// ---------------------------------------------------------------------------

test('AC1: workflows/loops/<name>.md projects to .claude/commands/loops/<name>.md', () => {
  const run = runSyncIsolated({
    payloadFiles: { 'loops/converge.md': LOOP_UNIT },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.ok(
      run.commands['loops/converge.md'],
      'loop unit must project under the loops/ namespace, preserving the subpath',
    );
    // The flat root must NOT carry a duplicate copy of the loop unit.
    assert.ok(
      !run.commands['converge.md'],
      'loop unit must not also be projected flat at the command root',
    );
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2: helpers/ is NOT projected
// ---------------------------------------------------------------------------

test('AC2: workflows/helpers/<name>.md is NOT projected (neither flat nor namespaced)', () => {
  const run = runSyncIsolated({
    payloadFiles: {
      'loops/converge.md': LOOP_UNIT,
      'helpers/deliver-story.md': HELPER_FILE,
    },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    // The loop unit projects...
    assert.ok(
      run.commands['loops/converge.md'],
      'loop unit must project (sanity check the fixture)',
    );
    // ...but the helper does NOT, under any path shape.
    assert.ok(
      !run.commands['deliver-story.md'],
      'helper must not be projected flat',
    );
    assert.ok(
      !run.commands['helpers/deliver-story.md'],
      'helper must not be projected under a helpers/ namespace',
    );
    assert.ok(
      !run.commands['loops/deliver-story.md'],
      'helper must not leak into the loops/ namespace',
    );
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3: namespaced /loops:<name> form (with documented flat fallback)
// ---------------------------------------------------------------------------

test('AC3: namespaced invocation is /loops:<name> (subpath preserved); flat fallback documented', () => {
  const run = runSyncIsolated({
    payloadFiles: { 'loops/converge.md': LOOP_UNIT },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);

    // The on-disk projection preserves the loops/ subpath — this is what
    // makes Claude Code namespace the command as /loops:converge.
    const projectedPath = 'loops/converge.md';
    assert.ok(
      run.commands[projectedPath],
      `projected path ${projectedPath} backs the namespaced ${namespacedCommand('converge')} command`,
    );

    // Body content is preserved and the payload header is applied.
    assert.ok(
      run.commands[projectedPath].includes('Loop fixture body'),
      'loop unit body must be preserved',
    );
    assert.ok(
      run.commands[projectedPath].includes(
        'AUTO-GENERATED — do not edit. Source of truth: .agents/workflows/',
      ),
      'loop unit must carry the payload header',
    );

    // The flat fallback form (/loops-converge) is the host-side flattening
    // of the same projected file; it is documented, not a second on-disk
    // copy, so no flat `loops-converge.md` should exist.
    assert.equal(
      namespacedCommand('converge'),
      '/loops:converge',
      'namespaced form is /loops:<name>',
    );
    assert.equal(
      flatFallbackCommand('converge'),
      '/loops-converge',
      'documented flat fallback form is /loops-<name>',
    );
    assert.ok(
      !run.commands['loops-converge.md'],
      'the flat fallback is a host-side rename, not a second projected file',
    );
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4: loop unit and flat command of the same basename coexist
// ---------------------------------------------------------------------------

test('AC4: a loop unit and a flat top-level command of the same basename coexist', () => {
  const run = runSyncIsolated({
    payloadFiles: {
      'converge.md': '# /converge\n\nA flat top-level command.\n',
      'loops/converge.md': LOOP_UNIT,
    },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.ok(
      run.commands['converge.md'],
      'flat top-level command must project at the root',
    );
    assert.ok(
      run.commands['loops/converge.md'],
      'loop unit of the same basename must project under loops/',
    );
    // They are distinct files with distinct content.
    assert.ok(
      run.commands['converge.md'].includes('A flat top-level command.'),
      'flat command keeps its own body',
    );
    assert.ok(
      run.commands['loops/converge.md'].includes('Loop fixture body'),
      'loop unit keeps its own body',
    );
  } finally {
    run.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5: removing a loop unit reaps its namespaced command on the next sync
// ---------------------------------------------------------------------------

test('AC5: removing a loop unit reaps loops/<name>.md without touching flat commands', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-loops-reap-'));
  try {
    const payloadSrc = path.join(tmp, 'workflows');
    fs.mkdirSync(path.join(payloadSrc, 'loops'), { recursive: true });
    fs.writeFileSync(path.join(payloadSrc, 'plan.md'), '# /plan\n', 'utf8');
    fs.writeFileSync(
      path.join(payloadSrc, 'loops', 'converge.md'),
      LOOP_UNIT,
      'utf8',
    );

    const dest = path.join(tmp, '.claude', 'commands');
    fs.mkdirSync(dest, { recursive: true });

    const env = {
      ...process.env,
      SYNC_CLAUDE_COMMANDS_SRC: payloadSrc,
      SYNC_CLAUDE_COMMANDS_DEST: dest,
    };

    const first = spawnSync(process.execPath, [SYNC_SCRIPT], {
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(
      fs.existsSync(path.join(dest, 'loops', 'converge.md')),
      'loop unit must project on first run',
    );
    assert.ok(
      fs.existsSync(path.join(dest, 'plan.md')),
      'flat command must project on first run',
    );

    // Remove the loop unit source.
    fs.unlinkSync(path.join(payloadSrc, 'loops', 'converge.md'));

    const second = spawnSync(process.execPath, [SYNC_SCRIPT], {
      cwd: tmp,
      env,
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      fs.existsSync(path.join(dest, 'loops', 'converge.md')),
      false,
      'orphaned loop unit must be reaped from the loops/ namespace',
    );
    // The unrelated flat command must survive.
    assert.ok(
      fs.existsSync(path.join(dest, 'plan.md')),
      'flat command must survive the loop-unit reap',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC6: loops/README.md is namespace documentation, not a /loops: command
// ---------------------------------------------------------------------------

test('AC6: workflows/loops/README.md is NOT projected as a /loops: command', () => {
  const run = runSyncIsolated({
    payloadFiles: {
      'loops/converge.md': LOOP_UNIT,
      'loops/README.md': '# Loops\n\nNamespace docs, not a loop unit.\n',
    },
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    // The real loop unit still projects under the namespace.
    assert.ok(
      run.commands['loops/converge.md'],
      'loop unit must still project under the loops/ namespace',
    );
    // The README must NOT project — neither namespaced nor flat.
    assert.ok(
      !run.commands['loops/README.md'],
      'loops/README.md must not project as /loops:README',
    );
    assert.ok(
      !run.commands['README.md'],
      'loops/README.md must not leak to the flat command root',
    );
  } finally {
    run.cleanup();
  }
});
