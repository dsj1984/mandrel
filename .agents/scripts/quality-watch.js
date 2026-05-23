#!/usr/bin/env node
/* node:coverage ignore file -- MI 0 long-lived chokidar watcher; one-shot dev tool that respawns quality-preview, no test seam without mocking the watcher event loop */

/**
 * .agents/scripts/quality-watch.js — chokidar wrapper around quality-preview.
 *
 * Long-lived watcher that re-runs `quality-preview` (debounced) whenever a
 * source file under the configured MI/CRAP target dirs changes. Designed for
 * `npm run quality:watch` — operators leave it running in a side terminal and
 * see live MI/CRAP deltas as they edit.
 *
 * Wiring:
 *   - chokidar.watch(targetDirs, { ignored: ['node_modules', '.git', ...] })
 *   - on 'add' | 'change' | 'unlink' → debounce, then spawn the preview.
 *   - SIGINT → close the watcher, exit 0.
 *
 * The preview spawn payload is exported as `buildPreviewSpawn` for unit tests
 * that stub `chokidar.watch` and assert what would be invoked. The watcher
 * factory (`createWatcher`) accepts injected `chokidar` and `spawn` so the
 * tests never load the real chokidar (devDependency) or actually fork node.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { getQuality, resolveConfig } from './lib/config-resolver.js';

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Resolve the union of MI + CRAP target dirs from the project's agent config.
 * Falls back to `['.agents/scripts', 'tests']` when neither block is
 * configured so the watcher always has something to watch in a fresh repo.
 *
 * Pure-ish — exported so tests can pass a synthetic config shape without
 * reaching into the real config resolver.
 *
 * @param {object} resolved Canonical resolved config (`resolveConfig()` output).
 * @returns {string[]}
 */
export function resolveWatchTargets(resolved) {
  const quality = getQuality(resolved);
  const miDirs = quality?.maintainability?.targetDirs ?? [];
  const crapDirs = quality?.crap?.targetDirs ?? [];
  const merged = Array.from(new Set([...miDirs, ...crapDirs]));
  if (merged.length === 0) return ['.agents/scripts', 'tests'];
  return merged;
}

/**
 * Build the spawn payload for the per-save preview run. Pure: returns the
 * exact `(command, args, options)` tuple that the watcher hands to `spawn`,
 * so unit tests can assert wire-level intent without forking node.
 *
 * @param {{ cwd?: string, ref?: string }} [opts]
 * @returns {{ command: string, args: string[], options: { cwd: string, stdio: 'inherit' } }}
 */
export function buildPreviewSpawn({ cwd = process.cwd(), ref = 'HEAD' } = {}) {
  return {
    command: process.execPath,
    args: [
      path.resolve(cwd, '.agents', 'scripts', 'quality-preview.js'),
      '--changed-since',
      ref,
    ],
    options: { cwd, stdio: 'inherit' },
  };
}

/**
 * Pure debouncer factory. Keeps the watcher's "I just saw N saves in 50ms"
 * behaviour testable without sleeping. Exported so the per-save coalescing
 * contract can be pinned in unit tests.
 *
 * @param {number} ms
 * @param {{ setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout }} [io]
 * @returns {{ schedule: (fn: () => void) => void, flush: () => void }}
 */
export function createDebouncer(
  ms,
  { setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout } = {},
) {
  let pending = null;
  let nextFn = null;
  return {
    schedule(fn) {
      nextFn = fn;
      if (pending) clearT(pending);
      pending = setT(() => {
        const f = nextFn;
        pending = null;
        nextFn = null;
        if (f) f();
      }, ms);
    },
    flush() {
      if (pending) {
        clearT(pending);
        pending = null;
      }
      if (nextFn) {
        const f = nextFn;
        nextFn = null;
        f();
      }
    },
  };
}

/**
 * Wire chokidar + spawn + the debouncer into a long-lived watcher. Returns a
 * `{ close }` handle so the caller (or tests) can shut it down deterministically.
 *
 * @param {{
 *   chokidar: { watch: (paths: string[], opts: object) => { on: Function, close: () => Promise<void> } },
 *   spawn?: typeof defaultSpawn,
 *   targets: string[],
 *   cwd?: string,
 *   ref?: string,
 *   debounceMs?: number,
 *   onSpawn?: (payload: ReturnType<typeof buildPreviewSpawn>) => void,
 *   stdout?: { write: (s: string) => void },
 * }} opts
 */
export function createWatcher({
  chokidar,
  spawn = defaultSpawn,
  targets,
  cwd = process.cwd(),
  ref = 'HEAD',
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onSpawn,
  stdout = process.stdout,
}) {
  const watcher = chokidar.watch(targets, {
    ignored: [/node_modules/, /\.git/, /\.worktrees/, /coverage/, /temp/],
    ignoreInitial: true,
    cwd,
  });
  const debouncer = createDebouncer(debounceMs);
  const trigger = () => {
    const payload = buildPreviewSpawn({ cwd, ref });
    if (onSpawn) onSpawn(payload);
    spawn(payload.command, payload.args, payload.options);
  };
  for (const ev of ['add', 'change', 'unlink']) {
    watcher.on(ev, (file) => {
      stdout.write(`[quality:watch] ${ev} ${file}\n`);
      debouncer.schedule(trigger);
    });
  }
  watcher.on('ready', () => {
    stdout.write(
      `[quality:watch] watching ${targets.length} target dir(s); press Ctrl+C to exit.\n`,
    );
  });
  return {
    /**
     * Resolve once chokidar has stopped watching. The wrapper triggers
     * `flush()` first so any in-flight save still produces one final preview
     * run before the process exits.
     */
    async close() {
      debouncer.flush();
      await watcher.close();
    },
    debouncer,
    watcher,
  };
}

/**
 * CLI entry. Lazy-loads the real chokidar so importing this module in tests
 * (which inject a stub) never touches the devDependency.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   chokidarLoader?: () => Promise<{ default?: object } & object>,
 *   resolved?: object,
 * }} [opts]
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  chokidarLoader = () => import('chokidar'),
  resolved,
} = {}) {
  void argv;
  const config = resolved ?? resolveConfig();
  const targets = resolveWatchTargets(config);
  const chokidarMod = await chokidarLoader();
  const chokidar = chokidarMod?.default ?? chokidarMod;
  const handle = createWatcher({ chokidar, targets, cwd });
  const shutdown = async () => {
    process.stdout.write('\n[quality:watch] SIGINT received; closing.\n');
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return handle;
}

// cli-opt-out: Windows-aware main-guard with leading-slash drive-letter normalisation; mirrors check-maintainability.js / check-crap.js so the diagnostic surface stays consistent across the gate suite.
// Only run main when invoked directly — keep the module importable from tests.
const isDirect = (() => {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const self = new URL(import.meta.url).pathname;
    const normalizedSelf = /^\/[A-Za-z]:/.test(self) ? self.slice(1) : self;
    return path.resolve(normalizedSelf) === invoked;
  } catch {
    return false;
  }
})();

if (isDirect) {
  runCli().catch((err) => {
    process.stderr.write(`[quality:watch] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
