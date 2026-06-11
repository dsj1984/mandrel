/**
 * Story #4045 — init tail sequencing, stub-marker detection, and /plan handoff.
 *
 * The `/onboard` slash command has been retired. Its four phases now live in
 * `lib/onboard/init-tail.js` and run as the configure-path tail of
 * `mandrel init`. These unit tests cover:
 *
 *   - init tail sequences all four phases in order.
 *   - Phase 1 (detect-stack) report is printed.
 *   - Phase 2 (scaffold offer) is skipped when all docs are present.
 *   - Phase 2 scaffold offer fires for missing docs; declines are logged loudly.
 *   - Phase 2 acceptance writes stubs and reports the MANDREL:STUB marker.
 *   - Phase 3 (doctor) gate: non-zero exit stops the tail (ok: false).
 *   - Phase 3 (doctor) gate: zero exit proceeds to Phase 4.
 *   - Phase 4 (/plan handoff) text is printed on a green doctor run.
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

const { runInitTail, PLAN_HANDOFF_TEXT } = await import(
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
function runTail(root, overrides = {}) {
  const lines = [];
  const stdout = (s) => lines.push(s);
  const result = runInitTail({ root, stdout, ...overrides });
  return { result, output: lines.join('') };
}

/** Doctor stub that returns the given status. */
const doctor = (status) => () => ({ status });

// ---------------------------------------------------------------------------
// Phase 1 — stack detection
// ---------------------------------------------------------------------------

describe('init tail — Phase 1 (stack detection)', () => {
  it('prints a stack detection report', () => {
    const root = track(makeProject([]));
    const { output } = runTail(root, {
      runDoctor: doctor(0),
      confirmScaffold: () => false,
      isTTY: false,
    });
    assert.match(output, /Stack detection/i);
    assert.match(output, /Package manager/i);
    assert.match(output, /Test runner/i);
    assert.match(output, /Primary language/i);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — scaffold offer
// ---------------------------------------------------------------------------

describe('init tail — Phase 2 (scaffold offer)', () => {
  it('skips the offer when all docsContextFiles are present', () => {
    const root = track(makeProject(['architecture.md']));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'architecture.md'), '# Arch\n');
    const { output } = runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    assert.match(output, /All docsContextFiles are present/i);
    assert.doesNotMatch(output, /Scaffold stubs now/i);
  });

  it('offers to scaffold when docs are missing', () => {
    const root = track(makeProject(['architecture.md']));
    const { output } = runTail(root, {
      runDoctor: doctor(0),
      confirmScaffold: () => false,
      isTTY: true,
    });
    assert.match(output, /Scaffold stubs now/i);
    assert.match(output, /architecture\.md/);
  });

  it('logs a loud decline message when scaffold is declined', () => {
    const root = track(makeProject(['architecture.md']));
    const { output } = runTail(root, {
      runDoctor: doctor(0),
      confirmScaffold: () => false,
      isTTY: true,
    });
    assert.match(output, /degraded context/i);
  });

  it('auto-declines on non-TTY without printing the offer', () => {
    const root = track(makeProject(['architecture.md']));
    const { output } = runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    // Offer text should not appear on non-TTY
    assert.doesNotMatch(output, /Scaffold stubs now/i);
    // Decline log should appear (auto-declined)
    assert.match(output, /degraded context/i);
  });

  it('writes stubs and reports the MANDREL:STUB marker on acceptance', () => {
    const root = track(makeProject(['decisions.md']));
    const { output, result } = runTail(root, {
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

  it('is idempotent: re-running does not overwrite a present file', () => {
    const root = track(makeProject(['arch.md']));
    fs.mkdirSync(path.join(root, 'docs'));
    const original = '# My Real Architecture\n';
    fs.writeFileSync(path.join(root, 'docs', 'arch.md'), original);
    runTail(root, {
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
// Phase 3 — doctor gate
// ---------------------------------------------------------------------------

describe('init tail — Phase 3 (doctor gate)', () => {
  it('returns ok=false and stops when doctor exits non-zero', () => {
    const root = track(makeProject([]));
    const { result, output } = runTail(root, {
      runDoctor: doctor(1),
      isTTY: false,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.doctorStatus, 1);
    assert.match(output, /Doctor check failed/i);
    // Phase 4 handoff must not appear
    assert.doesNotMatch(output, /Mandrel is ready/i);
  });

  it('returns ok=true when doctor exits 0', () => {
    const root = track(makeProject([]));
    const { result } = runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.doctorStatus, 0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — /plan handoff
// ---------------------------------------------------------------------------

describe('init tail — Phase 4 (/plan handoff)', () => {
  it('prints the /plan handoff text when doctor passes', () => {
    const root = track(makeProject([]));
    const { output } = runTail(root, {
      runDoctor: doctor(0),
      isTTY: false,
    });
    assert.match(output, /\/plan/);
    assert.ok(
      output.includes(PLAN_HANDOFF_TEXT),
      'PLAN_HANDOFF_TEXT should appear in output',
    );
  });

  it('does not print the handoff when doctor fails', () => {
    const root = track(makeProject([]));
    const { output } = runTail(root, {
      runDoctor: doctor(1),
      isTTY: false,
    });
    assert.doesNotMatch(output, /Mandrel is ready/);
  });
});

// ---------------------------------------------------------------------------
// /onboard retirement
// ---------------------------------------------------------------------------

describe('/onboard retirement', () => {
  it('onboard.md no longer exists in .agents/workflows/', () => {
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
