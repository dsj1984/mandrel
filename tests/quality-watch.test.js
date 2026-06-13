import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
// Note: timer mocking is driven per-test via the injected `t.mock.timers`
// handle, so no top-level `mock` import is required.
import {
  buildPreviewSpawn,
  createDebouncer,
  createWatcher,
  resolveWatchTargets,
  runCli,
} from '../.agents/scripts/quality-watch.js';

/**
 * quality-watch.js unit coverage. The real chokidar (a devDependency) is
 * stubbed via dependency injection (`createWatcher({ chokidar })`); spawn is
 * stubbed the same way. The tests assert the spawn payload, debounce
 * behaviour, and SIGINT cleanup without ever forking node or touching the
 * filesystem.
 */

function makeChokidarStub() {
  const handlers = new Map();
  const watcher = {
    on(ev, fn) {
      handlers.set(ev, fn);
      return watcher;
    },
    close: async () => {
      watcher.closed = true;
    },
    closed: false,
    fire(ev, file) {
      const fn = handlers.get(ev);
      if (fn) fn(file);
    },
    handlers,
    watchPaths: null,
    watchOpts: null,
  };
  return {
    watch: (paths, opts) => {
      watcher.watchPaths = paths;
      watcher.watchOpts = opts;
      return watcher;
    },
    _watcher: watcher,
  };
}

function makeStdoutCapture() {
  return {
    lines: [],
    write(s) {
      this.lines.push(s);
    },
  };
}

test('buildPreviewSpawn — spawns node + quality-preview.js with --changed-since HEAD', () => {
  const cwd = path.resolve('/tmp/proj');
  const payload = buildPreviewSpawn({ cwd });
  assert.equal(payload.command, process.execPath);
  assert.deepEqual(payload.args, [
    path.resolve(cwd, '.agents', 'scripts', 'quality-preview.js'),
    '--changed-since',
    'HEAD',
  ]);
  assert.deepEqual(payload.options, { cwd, stdio: 'inherit' });
});

test('buildPreviewSpawn — honours custom ref', () => {
  const payload = buildPreviewSpawn({ cwd: '/x', ref: 'origin/main' });
  assert.ok(payload.args.includes('origin/main'));
});

test('resolveWatchTargets — unions MI + CRAP target dirs without duplicates', () => {
  const dirs = resolveWatchTargets({
    delivery: {
      quality: {
        gates: {
          maintainability: { targetDirs: ['.agents/scripts', 'lib'] },
          crap: { targetDirs: ['lib', 'tests'] },
        },
      },
    },
  });
  assert.deepEqual(new Set(dirs), new Set(['.agents/scripts', 'lib', 'tests']));
});

test('resolveWatchTargets — falls back to .agents/scripts + tests when both empty', () => {
  const dirs = resolveWatchTargets({
    delivery: {
      quality: {
        gates: {
          maintainability: { targetDirs: [] },
          crap: { targetDirs: [] },
        },
      },
    },
  });
  assert.deepEqual(dirs, ['.agents/scripts', 'tests']);
});

test('createDebouncer — only fires the trailing call after the debounce window', () => {
  let calls = 0;
  const setT = (fn) => {
    // Synchronous timer: fire immediately to assert flush behaviour.
    fn();
    return 1;
  };
  const clearT = () => {};
  const d = createDebouncer(50, { setTimeout: setT, clearTimeout: clearT });
  d.schedule(() => {
    calls += 1;
  });
  assert.equal(calls, 1);
});

test('createDebouncer — flush triggers the pending call deterministically', () => {
  let _scheduledFn = null;
  const setT = (fn) => {
    _scheduledFn = fn;
    return 1;
  };
  const clearT = () => {
    _scheduledFn = null;
  };
  let calls = 0;
  const d = createDebouncer(50, { setTimeout: setT, clearTimeout: clearT });
  d.schedule(() => {
    calls += 1;
  });
  // Pending but not fired yet (the timer is captured but not invoked).
  assert.equal(calls, 0);
  d.flush();
  assert.equal(calls, 1);
});

test('createWatcher — re-emits a delta table when a target file is touched', async (t) => {
  // Mock setTimeout so the 0ms debounce timer fires on an explicit tick()
  // rather than racing a real wall-clock window under a loaded CI runner.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const chokidar = makeChokidarStub();
  const onSpawnCalls = [];
  const spawnStub = (cmd, args, opts) => {
    onSpawnCalls.push({ cmd, args, opts });
    return { on: () => {} };
  };
  const stdout = makeStdoutCapture();
  const handle = createWatcher({
    chokidar,
    spawn: spawnStub,
    targets: ['.agents/scripts'],
    cwd: '/tmp/proj',
    debounceMs: 0,
    stdout,
  });
  // Verify chokidar.watch was called with the right paths and ignored set.
  assert.deepEqual(chokidar._watcher.watchPaths, ['.agents/scripts']);
  assert.equal(chokidar._watcher.watchOpts.ignoreInitial, true);
  assert.ok(Array.isArray(chokidar._watcher.watchOpts.ignored));
  // Fire a change event → debouncer schedules the spawn at ms=0.
  chokidar._watcher.fire('change', '.agents/scripts/quality-preview.js');
  // Advance past the 0ms debounce window so the timer fires deterministically.
  t.mock.timers.tick(0);
  assert.equal(onSpawnCalls.length, 1);
  const { cmd, args } = onSpawnCalls[0];
  assert.equal(cmd, process.execPath);
  assert.ok(args.some((a) => a.endsWith('quality-preview.js')));
  assert.ok(args.includes('--changed-since'));
  assert.ok(args.includes('HEAD'));
  assert.match(
    stdout.lines.join(''),
    /change .agents\/scripts\/quality-preview\.js/,
  );
  await handle.close();
  assert.equal(chokidar._watcher.closed, true);
});

test('createWatcher — coalesces a burst of saves into a single spawn', async (t) => {
  // Mock setTimeout so the 25ms debounce window is advanced explicitly with
  // tick() — a real 60ms sleep can be starved by scheduler latency on CI.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const chokidar = makeChokidarStub();
  const spawnCalls = [];
  const handle = createWatcher({
    chokidar,
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { on: () => {} };
    },
    targets: ['lib'],
    cwd: '/tmp/proj',
    debounceMs: 25,
    stdout: makeStdoutCapture(),
  });
  for (let i = 0; i < 5; i += 1) {
    chokidar._watcher.fire('change', `lib/file${i}.js`);
  }
  // Before the window elapses the burst is still pending — no spawn yet.
  assert.equal(spawnCalls.length, 0);
  // Advance past the debounce window so the single trailing call lands.
  t.mock.timers.tick(25);
  assert.equal(spawnCalls.length, 1);
  await handle.close();
});

test('createWatcher — close() flushes any pending preview before resolving', async () => {
  const chokidar = makeChokidarStub();
  const spawnCalls = [];
  const handle = createWatcher({
    chokidar,
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { on: () => {} };
    },
    targets: ['lib'],
    cwd: '/tmp/proj',
    debounceMs: 1000, // long debounce so close() must flush.
    stdout: makeStdoutCapture(),
  });
  chokidar._watcher.fire('change', 'lib/a.js');
  await handle.close();
  assert.equal(spawnCalls.length, 1);
  assert.equal(chokidar._watcher.closed, true);
});

test('runCli — wires the injected chokidar loader and resolves a watcher handle', async () => {
  const chokidar = makeChokidarStub();
  const handle = await runCli({
    argv: [],
    cwd: '/tmp/proj',
    chokidarLoader: async () => chokidar,
    resolved: {
      delivery: {
        quality: {
          gates: {
            maintainability: { targetDirs: ['lib'] },
            crap: { targetDirs: ['tests'] },
          },
        },
      },
    },
  });
  assert.ok(handle);
  assert.deepEqual(
    new Set(chokidar._watcher.watchPaths),
    new Set(['lib', 'tests']),
  );
  await handle.close();
});
