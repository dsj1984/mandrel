// tests/e2e/init-interactive.integration.test.js
/**
 * PTY-backed interactive regression guard for `mandrel init` (Story #4124,
 * under Epic #4118). Closes the blind spot every seam-mocked `init` test has:
 * the bugs fixed in #4106 only manifest against a **real terminal**, which the
 * injected-seam unit tests (`tests/cli/init.test.js`) cannot reproduce.
 *
 * The two #4106 failure modes this file guards against:
 *
 *   1. **The EOF-blocking hang.** The original confirm read the answer with a
 *      bare `fs.readFileSync(0)`, which blocks for EOF on an interactive TTY
 *      and hangs `mandrel init` forever. The fix (`lib/cli/init.js`
 *      `defaultConfirm`) reads a single line via `node:readline` and returns on
 *      Enter. Guard: the child must **exit on a keystroke + Enter**, never time
 *      out. A reintroduced blocking read trips the PTY watchdog → `timedOut`.
 *
 *   2. **The erased prompt.** `node:readline` in terminal mode emits cursor
 *      escapes (`\x1b[1G\x1b[0J` — column-1 + erase-to-end-of-screen) when it
 *      takes over the line, which **wipes the `[Y/n]:` prompt** already written
 *      to stdout. The fix sets `terminal: false` on the readline interface.
 *      Guard: the literal `[Y/n]` prompt text must **survive** in the captured
 *      PTY output. A reintroduced terminal-mode readline erases it.
 *
 * ## Why a PTY, and why this is hermetic
 *
 * `runMandrel` (plain pipes) leaves `process.stdin/stdout.isTTY === false`, so
 * `init` skips the prompt entirely and the bugs are invisible. `runMandrelPTY`
 * spawns the **real** `node bin/mandrel.js init` under a pseudo-terminal so both
 * `isTTY` flags are true, exactly as an operator's terminal.
 *
 * To stay hermetic the temp consumer is pre-seeded with a `.agents/` directory.
 * `planInit` only runs its `npm install mandrel` + `sync` steps when `.agents/`
 * is **absent** (cold start); with it present, `init` skips straight to the
 * prompt — no network, no install. The driver then answers **`n`** (files-only),
 * the branch that just prints a re-run hint and exits 0 **without** running
 * `bootstrap.js` or any GitHub provisioning. So the test exercises the full real
 * prompt + readline path (the #4106 surface) with zero side effects.
 *
 * Tier: the `.integration.test.js` suffix auto-registers this in the per-PR
 * integration tier (`INTEGRATION_INCLUDE` in test-tiers.js); no wiring edit
 * needed. Each `it` has a hard `timeout` so a regression fails fast rather than
 * hanging the suite. Every temp dir is torn down in `afterEach`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  cleanupAll,
  makeTempConsumer,
  runMandrelPTY,
} from './helpers/cli-harness.js';

/**
 * The exact prompt substring `init` writes before reading the confirm answer
 * (see `PROMPT_TEXT` in `lib/cli/init.js`). Its presence in the capture proves
 * the prompt was emitted at all (a sanity check that the prompt path ran).
 */
const PROMPT_NEEDLE = 'Begin interactive setup? [Y/n]:';

/**
 * The cursor-control signature of the #4106 erase regression.
 *
 * IMPORTANT — why a raw substring search for the prompt text is NOT enough: a
 * PTY capture is the literal byte stream, and the prompt text is written
 * *before* readline emits its escapes, so the prompt bytes are present in the
 * capture **whether or not** a terminal would have erased them at render time.
 * The discriminating signal is therefore the escape sequence itself. In
 * terminal mode (`terminal: true`, the bug) `node:readline` emits
 * `\x1b[1G` (cursor to column 1) immediately followed by `\x1b[0J` (erase from
 * cursor to end of display) when it takes over the line — together they wipe
 * the `[Y/n]:` prompt. The fix (`terminal: false`) emits **no** such escape, so
 * the absence of this sequence is the precise, render-accurate guard. The
 * literal escape characters are spelled with `` (ESC).
 */
const ERASE_DISPLAY_SEQUENCE = '[1G[0J';

/**
 * The files-only hint `init` prints when the operator declines (answers `n`).
 * Seeing it proves the readline answer was actually read (not swallowed by a
 * hang) and routed down the no-bootstrap branch.
 */
const FILES_ONLY_NEEDLE = 'Setup any time with: npx mandrel init';

/** Per-test hard ceiling. A #4106 hang would otherwise run unbounded. */
const TEST_TIMEOUT_MS = 30000;

/**
 * Pre-seed a temp consumer so `mandrel init` skips its cold-start install/sync
 * and goes straight to the interactive prompt. `planInit` keys that decision on
 * the presence of `./.agents/`, so a single marker file under `.agents/` is
 * enough — no real payload, no network.
 *
 * @returns {{ dir: string, agentsDir: string, cleanup: () => void }}
 */
function makeSeededConsumer() {
  const consumer = makeTempConsumer({ prefix: 'mandrel-init-pty-' });
  fs.mkdirSync(consumer.agentsDir, { recursive: true });
  // A marker so `.agents/` is a non-empty real directory; `planInit` only
  // probes existence, but a present file keeps the seed unambiguous.
  fs.writeFileSync(
    path.join(consumer.agentsDir, '.seeded'),
    '# pre-seeded so init skips cold-start install\n',
  );
  return consumer;
}

/**
 * node-pty ships native prebuilds for darwin + win32 only; on Linux it compiles
 * via its `install` lifecycle script, which CI suppresses with
 * `npm ci --ignore-scripts`. When the native binary cannot load,
 * `import('node-pty')` throws — skip the PTY guard here rather than red the
 * suite. The #4106 bug is platform-agnostic, so local (macOS) and
 * Windows-prebuild runs still exercise it; a follow-up can add a Linux native
 * build to the CI test job so it gates there too.
 *
 * Two distinct unsupported-host modes are handled: (1) the native binary fails
 * to load (`import` throws — caught below); and (2) the binary loads but the
 * host denies PTY allocation at spawn time (`posix_spawnp failed` — restricted
 * macOS hosts and sandboxed CI containers). The import-time catch does not
 * cover mode (2), so probe the real spawn path once and skip on failure rather
 * than red the suite. The #4106 bug stays gated on every host that can spawn a
 * PTY (CI included).
 */
let PTY_SKIP = false;
try {
  const ptyModule = await import('node-pty');
  const pty = ptyModule.default ?? ptyModule;
  try {
    const probe = pty.spawn(process.execPath, ['-e', 'process.exit(0)'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    try {
      probe.kill();
    } catch {
      // probe already exited — nothing to reap
    }
  } catch (spawnErr) {
    PTY_SKIP =
      `node-pty cannot allocate a PTY on this host (${spawnErr?.code ?? spawnErr?.message ?? 'spawn failed'}); ` +
      'PTY #4106 guard skipped on this platform/runner';
  }
} catch (err) {
  PTY_SKIP =
    `node-pty native binary unavailable (${err?.code ?? err?.message ?? 'load failed'}); ` +
    'PTY #4106 guard skipped on this platform/runner';
}

describe('mandrel init — PTY-backed interactive prompt (#4106 regression, e2e)', () => {
  /** @type {{ dir: string, agentsDir: string, cleanup: () => void }} */
  let consumer;

  beforeEach(() => {
    consumer = makeSeededConsumer();
  });

  afterEach(() => {
    cleanupAll();
  });

  it('advances and exits cleanly on a keystroke + Enter (no #4106 EOF hang)', {
    timeout: TEST_TIMEOUT_MS,
    skip: PTY_SKIP,
  }, async () => {
    // Arrange + Act: drive the real binary under a PTY, answering "n\r".
    const result = await runMandrelPTY(consumer.dir, ['init'], {
      input: 'n\r',
      timeoutMs: 15000,
    });

    // Assert: the child must have EXITED — a reintroduced blocking
    // `readFileSync(0)` would hang until the watchdog kills it (timedOut).
    assert.equal(
      result.timedOut,
      false,
      `mandrel init hung on an interactive TTY (the #4106 EOF-read regression).\n` +
        `Captured output:\n${result.output}`,
    );
    assert.equal(
      result.exitCode,
      0,
      `expected a clean (files-only) exit 0, got exitCode=${String(result.exitCode)} ` +
        `signal=${String(result.signal)}\nCaptured output:\n${result.output}`,
    );
  });

  it('keeps the [Y/n] prompt visible — readline terminal mode must not erase it', {
    timeout: TEST_TIMEOUT_MS,
    skip: PTY_SKIP,
  }, async () => {
    // Arrange + Act.
    const result = await runMandrelPTY(consumer.dir, ['init'], {
      input: 'n\r',
      timeoutMs: 15000,
    });

    // Guard against a hang first so the prompt assertion below reads against
    // a complete, real capture rather than a watchdog-truncated one.
    assert.equal(
      result.timedOut,
      false,
      `mandrel init hung before the prompt could be evaluated.\n` +
        `Captured output:\n${result.output}`,
    );

    // Sanity: the prompt was emitted at all (the prompt path ran).
    assert.ok(
      result.output.includes(PROMPT_NEEDLE),
      `expected the "[Y/n]" prompt to be written; the prompt path may not ` +
        `have run.\nExpected to find: ${JSON.stringify(PROMPT_NEEDLE)}\n` +
        `Captured output:\n${JSON.stringify(result.output)}`,
    );

    // Assert (the load-bearing #4106 "prompt not erased" guard): the readline
    // terminal-mode erase escape (`\x1b[1G\x1b[0J`) is ABSENT. In terminal
    // mode that sequence wipes the prompt line; with the `terminal: false`
    // fix readline emits no such escape. Asserting on the escape — not on the
    // prompt bytes, which are present in the raw stream regardless — is what
    // makes this catch the regression (see ERASE_DISPLAY_SEQUENCE).
    assert.ok(
      !result.output.includes(ERASE_DISPLAY_SEQUENCE),
      `readline emitted a column-1 + erase-to-end-of-display escape that ` +
        `wipes the "[Y/n]" prompt — the #4106 regression (defaultConfirm must ` +
        `keep terminal:false).\nFound erase sequence: ${JSON.stringify(ERASE_DISPLAY_SEQUENCE)}\n` +
        `Captured output:\n${JSON.stringify(result.output)}`,
    );

    // And the decline branch actually ran (the answer was read, then routed
    // to files-only), proving the prompt round-trip completed end to end.
    assert.ok(
      result.output.includes(FILES_ONLY_NEEDLE),
      `expected the files-only hint after answering "n"; the confirm answer ` +
        `may not have been read.\nCaptured output:\n${JSON.stringify(result.output)}`,
    );
  });
});
