/**
 * Story #4045 — init tail sequencing, stub-marker detection, and /plan handoff.
 *
 * The `/onboard` slash command has been retired. Its four phases now live in
 * `lib/onboard/init-tail.js` and run as the configure-path tail of
 * `mandrel init`. These unit tests cover:
 *
 *   - init tail sequences all three phases in order.
 *   - Phase 1 (scaffold offer) is skipped when all docs are present.
 *   - Phase 1 scaffold offer fires for missing docs; declines are logged loudly.
 *   - Phase 1 acceptance writes stubs and reports the MANDREL:STUB marker.
 *   - Phase 2 (doctor) gate: non-zero exit stops the tail (ok: false).
 *   - Phase 2 (doctor) gate: zero exit proceeds to Phase 3.
 *   - Phase 3 (/plan handoff) text is printed on a green doctor run.
 *   - Non-TTY: scaffold offer auto-declines without prompting.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const { runInitTail, readConfirm, PLAN_HANDOFF_TEXT } = await import(
  pathToFileURL(
    path.resolve(REPO_ROOT, '.agents/scripts/lib/onboard/init-tail.js'),
  ).href
);
const { STUB_MARKER } = await import(
  pathToFileURL(
    path.resolve(REPO_ROOT, '.agents/scripts/lib/onboard/scaffold-docs.js'),
  ).href
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp project root with a minimal .agentrc.json. */
function makeProject(docsContextFiles = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-tail-'));
  fs.writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify({
      project: {
        paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        docsContextFiles,
      },
    }),
  );
  return root;
}

let roots = [];
beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function track(root) {
  roots.push(root);
  return root;
}

/** Collect stdout output from runInitTail. */
async function runTail(root, overrides = {}) {
  const lines = [];
  const stdout = (s) => lines.push(s);
  const result = await runInitTail({ root, stdout, ...overrides });
  return { result, output: lines.join('') };
}

/** Doctor stub that returns the given status. */
const doctor = (status) => () => ({ status });

// ---------------------------------------------------------------------------
// Phase 1 — scaffold offer
// ---------------------------------------------------------------------------

describe('init tail — Phase 1 (scaffold offer)', async () => {
  it('skips the offer when all docsContextFiles are present', async () => {
    const root = track(makeProject(['architecture.md']));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'architecture.md'), '# Arch\n');
    const { output } = await runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    assert.match(output, /All docsContextFiles are present/i);
    assert.doesNotMatch(output, /Create placeholders/i);
  });

  it('offers to scaffold when docs are missing', async () => {
    const root = track(makeProject(['architecture.md']));
    const { output } = await runTail(root, {
      runDoctor: doctor(0),
      confirmScaffold: () => false,
      isTTY: true,
    });
    assert.match(output, /Create placeholders/i);
    assert.match(output, /architecture\.md/);
  });

  it('logs a loud decline message when scaffold is declined', async () => {
    const root = track(makeProject(['architecture.md']));
    const { output } = await runTail(root, {
      runDoctor: doctor(0),
      confirmScaffold: () => false,
      isTTY: true,
    });
    assert.match(output, /degraded context/i);
  });

  it('auto-declines on non-TTY without printing the offer', async () => {
    const root = track(makeProject(['architecture.md']));
    const { output } = await runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    // Offer text should not appear on non-TTY
    assert.doesNotMatch(output, /Create placeholders/i);
    // Decline log should appear (auto-declined)
    assert.match(output, /degraded context/i);
  });

  it('writes stubs and reports the MANDREL:STUB marker on acceptance', async () => {
    const root = track(makeProject(['decisions.md']));
    const { output, result } = await runTail(root, {
      runDoctor: doctor(0),
      confirmScaffold: () => true,
      isTTY: true,
    });
    const created = path.join(root, 'docs', 'decisions.md');
    assert.ok(fs.existsSync(created), 'decisions.md should be created');
    const body = fs.readFileSync(created, 'utf8');
    assert.ok(
      body.includes(STUB_MARKER),
      'scaffolded stub must carry MANDREL:STUB marker',
    );
    assert.match(output, /MANDREL:STUB/);
    assert.deepEqual(result.scaffoldResult.created, ['decisions.md']);
  });

  it('is idempotent: re-running does not overwrite a present file', async () => {
    const root = track(makeProject(['arch.md']));
    fs.mkdirSync(path.join(root, 'docs'));
    const original = '# My Real Architecture\n';
    fs.writeFileSync(path.join(root, 'docs', 'arch.md'), original);
    await runTail(root, {
      runDoctor: doctor(0),
      confirmScaffold: () => true,
      isTTY: true,
    });
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'docs', 'arch.md'), 'utf8'),
      original,
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — doctor gate
// ---------------------------------------------------------------------------

describe('init tail — Phase 2 (doctor gate)', async () => {
  it('returns ok=false and stops when doctor exits non-zero', async () => {
    const root = track(makeProject([]));
    const { result, output } = await runTail(root, {
      runDoctor: doctor(1),
      isTTY: false,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.doctorStatus, 1);
    assert.match(output, /Doctor check failed/i);
    // Phase 3 handoff must not appear
    assert.doesNotMatch(output, /Mandrel is ready/i);
  });

  it('returns ok=true when doctor exits 0', async () => {
    const root = track(makeProject([]));
    const { result } = await runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.doctorStatus, 0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — /plan handoff
// ---------------------------------------------------------------------------

describe('init tail — Phase 3 (/plan handoff)', async () => {
  it('prints the /plan handoff text when doctor passes', async () => {
    const root = track(makeProject([]));
    const { output } = await runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    assert.match(output, /\/plan/);
    assert.ok(
      output.includes(PLAN_HANDOFF_TEXT),
      'PLAN_HANDOFF_TEXT should appear in output',
    );
  });

  it('does not print the handoff when doctor fails', async () => {
    const root = track(makeProject([]));
    const { output } = await runTail(root, {
      runDoctor: doctor(1),
      isTTY: false,
    });
    assert.doesNotMatch(output, /Mandrel is ready/);
  });
});

// ---------------------------------------------------------------------------
// /onboard retirement
// ---------------------------------------------------------------------------

describe('/onboard retirement', async () => {
  it('onboard.md no longer exists in .agents/workflows/', async () => {
    const onboardPath = path.join(
      REPO_ROOT,
      '.agents',
      'workflows',
      'onboard.md',
    );
    assert.strictEqual(
      fs.existsSync(onboardPath),
      false,
      'onboard.md must be removed — /onboard is retired',
    );
  });
});

// ---------------------------------------------------------------------------
// readConfirm — scaffold-prompt erase regression guard
// ---------------------------------------------------------------------------

describe('init tail — readConfirm readline options', () => {
  it('creates the readline interface with terminal:false so the scaffold prompt is not erased', async () => {
    let captured;
    const createInterface = (opts) => {
      captured = opts;
      return { question: async () => 'y', close: () => {} };
    };
    const result = await readConfirm({ createInterface });
    assert.equal(
      captured.terminal,
      false,
      'readConfirm must pass terminal:false to readline.createInterface',
    );
    assert.equal(result, true, 'a "y" answer resolves to true (scaffold)');
  });

  it('treats Enter and anything but an explicit no as accept (default-true for the scaffold offer)', async () => {
    const make = (answer) => ({
      createInterface: () => ({
        question: async () => answer,
        close: () => {},
      }),
    });
    assert.equal(await readConfirm(make('y')), true);
    assert.equal(await readConfirm(make('yes')), true);
    assert.equal(await readConfirm(make('')), true);
    assert.equal(await readConfirm(make('n')), false);
    assert.equal(await readConfirm(make('no')), false);
  });
});
