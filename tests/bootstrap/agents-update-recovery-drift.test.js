/**
 * agents-update-recovery-drift.test.js — Story #4172
 *
 * The `/agents-update` workflow ([`.agents/workflows/agents-update.md`])
 * documents a **partial-upgrade recovery** step (Step 2.5): when a
 * post-install phase of `mandrel update` fails, the lockfile bump is already
 * staged while `.agents/` may be half-materialized, so the operator must run
 * an exact per-phase manual remedy before committing.
 *
 * The per-phase remedy command strings in the workflow MUST stay in lockstep
 * with the hint strings [`lib/cli/update.js`] actually emits — the CLI is the
 * single source of truth. If the two drift, an operator following the workflow
 * runs a stale command (or one that no longer matches what the CLI told them),
 * which is exactly the silent-mismatch failure this Story exists to prevent.
 *
 * Rather than match the CLI's *source* text (whose nested template-literal
 * backtick escaping does not equal the *emitted* string), this contract test
 * drives `runUpdate` with a `spawnPhase` seam that fails each post-install
 * phase in turn, captures the real emitted recovery hint (the thrown error
 * message, or the doctor stderr), and asserts that hint appears verbatim in the
 * workflow doc. It is a fail-fast drift gate: change a hint string in update.js
 * without updating the Step 2.5 recovery section (or vice versa) and this test
 * goes red.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runUpdate } from '../../lib/cli/update.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/**
 * Collapse all runs of whitespace (including the newline + indent a markdown
 * prose-wrap inserts) to a single space, so the verbatim-substring check is
 * resilient to line wrapping in the workflow doc. The drift gate keys on the
 * *words* the CLI and the workflow share, not on incidental formatting.
 */
const normalizeWs = (s) => s.replace(/\s+/g, ' ').trim();

const workflowRawSrc = fs.readFileSync(
  path.join(repoRoot, '.agents', 'workflows', 'agents-update.md'),
  'utf8',
);
const workflowSrc = normalizeWs(workflowRawSrc);

const CURRENT = '1.44.0';
const TARGET = '1.46.0';

/**
 * Drive `runUpdate` with a `spawnPhase` seam that makes exactly `failPhase`
 * exit non-zero (all earlier phases succeed) and capture the emitted recovery
 * hint. For sync / sync-commands / migrate the orchestrator throws — the hint
 * is the thrown message. For doctor it does not throw; it writes to stderr and
 * calls exit(1) — the hint is the captured stderr.
 *
 * @param {'sync' | 'sync-commands' | 'migrate' | 'doctor'} failPhase
 * @returns {Promise<string>} The emitted recovery hint text.
 */
async function captureHint(failPhase) {
  const errChunks = [];
  const opts = {
    argv: [],
    currentVersion: CURRENT,
    resolveTargetVersion: async () => TARGET,
    npmUpdate: async () => {},
    spawnPhase: async (phase) => ({
      ok: phase !== failPhase,
      stdout: '',
      stderr: '',
    }),
    cwd: () => '/fake/cwd',
    surfaceChangelog: async () => {},
    write: () => {},
    writeErr: (s) => errChunks.push(s),
    exit: () => {},
  };

  if (failPhase === 'doctor') {
    // doctor failure does not throw — it writes the remedy hint to stderr.
    await runUpdate(opts);
    return errChunks.join('');
  }

  let thrown;
  try {
    await runUpdate(opts);
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown,
    `expected runUpdate to throw when the ${failPhase} phase fails`,
  );
  return thrown.message;
}

describe('agents-update partial-upgrade recovery — CLI ↔ workflow drift', () => {
  it('quotes every per-phase recovery hint the CLI actually emits', async () => {
    const phases = ['sync', 'sync-commands', 'migrate', 'doctor'];
    for (const phase of phases) {
      // eslint-disable-next-line no-await-in-loop
      const rawHint = await captureHint(phase);
      const hint = normalizeWs(rawHint);

      // The actionable "Run `…` manually / Run `mandrel doctor` for remedies"
      // sentence is the drift-prone payload the workflow must reproduce. Pull
      // the `Run …` fragment out of the emitted message and assert it appears
      // verbatim in the workflow.
      const m = /Run `[^`]+`[^.]*\./.exec(hint);
      assert.ok(
        m,
        `the ${phase} recovery hint did not contain a "Run \`…\`" remedy ` +
          `sentence — got: ${hint}`,
      );
      // The migrate hint interpolates concrete versions; the workflow quotes
      // it with `<cur>` / `<target>` placeholders. Map the live versions back
      // to those placeholders so the verbatim comparison holds for every phase.
      const remedySentence = m[0]
        .replaceAll(CURRENT, '<cur>')
        .replaceAll(TARGET, '<target>');

      assert.ok(
        workflowSrc.includes(remedySentence),
        `.agents/workflows/agents-update.md is missing the ${phase} recovery ` +
          `hint "${remedySentence}" emitted by lib/cli/update.js. The Step 2.5 ` +
          'recovery section must quote the CLI hint strings verbatim.',
      );
    }
  });

  it('frames partial-upgrade recovery as a pre-commit blocker', () => {
    assert.ok(
      /##\s+Step 2\.5\s+—\s+Partial-upgrade recovery/.test(workflowRawSrc),
      'agents-update.md must document a "Step 2.5 — Partial-upgrade recovery" step.',
    );
    assert.ok(
      /blocker/i.test(workflowRawSrc) &&
        /partial(ly)?-upgrade/i.test(workflowRawSrc),
      'The partial-upgrade recovery step must be framed as a blocker.',
    );
  });
});
