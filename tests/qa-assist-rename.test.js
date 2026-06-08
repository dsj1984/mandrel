/**
 * qa-assist rename / cutover guard (Epic #3798 / Story #3813).
 *
 * The f2-qa-assist hard cutover split exploratory QA into two siblings that
 * differ on *who drives*:
 *
 *   - `/qa-explore` is **agent-led** (the agent drives, the operator gates).
 *   - `/qa-assist`  is **human-led** (the human drives, the agent enriches).
 *
 * Before the cutover, the single exploratory workflow was framed as
 * "human-in-the-loop / human-driven". This spec is the green-build gate that
 * proves the rename landed across the tracked surface:
 *
 *   1. `.agents/workflows/qa-assist.md` exists and the generated
 *      `.claude/commands/qa-assist.md` mirror exists (re-run
 *      `npm run sync:commands` if missing).
 *   2. `.agents/workflows/qa-explore.md` exists and declares itself agent-led,
 *      explicitly disclaiming any human-driven flow (which now lives in
 *      `/qa-assist`).
 *   3. No tracked file under `.agents/`, `docs/`, or `.claude/` describes
 *      `/qa-explore` as human-driven. A line is an offender only when it
 *      mentions qa-explore AND frames it with a human-driven descriptor
 *      ("human-driven", "human-led", "human-in-the-loop") as an *assertion*
 *      about qa-explore itself. Two correct constructions are exempted:
 *        - a disclaimer — the qa-explore workflow's own "No human-driven flow
 *          lives in `/qa-explore`" line; and
 *        - the sibling framing — a line that also mentions `/qa-assist`, where
 *          the human-led descriptor qualifies qa-assist (the human-led
 *          sibling), not qa-explore (e.g. "the **human-led** sibling of
 *          `/qa-explore`").
 */

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const ASSIST_WORKFLOW = '.agents/workflows/qa-assist.md';
const ASSIST_COMMAND = '.claude/commands/qa-assist.md';
const EXPLORE_WORKFLOW = '.agents/workflows/qa-explore.md';

const SCAN_ROOTS = [
  path.join(REPO_ROOT, '.agents'),
  path.join(REPO_ROOT, 'docs'),
  path.join(REPO_ROOT, '.claude'),
];

// Directories that hold generated mirrors, installed dependencies, or
// historical breadcrumbs — none of which are live consumers.
const EXCLUDED_DIRS = new Set(['node_modules', '.worktrees', 'archive']);

// This test file talks about the human-driven framing in prose, so exclude it
// from its own scan.
const SELF = path.join(REPO_ROOT, 'tests', 'qa-assist-rename.test.js');

// Descriptors that, when applied to qa-explore as an assertion, are stale.
const HUMAN_DRIVEN_DESCRIPTORS = /human-driven|human-led|human-in-the-loop/i;
// A disclaimer like "No human-driven flow lives in `/qa-explore`" is correct
// and must not be flagged.
const DISCLAIMER = /\bno\b[^.\n]*human-driven|human-driven flow lives here/i;
// "the **human-led** sibling of `/qa-explore`" — the descriptor binds to the
// sibling (/qa-assist); qa-explore is merely the object of "sibling of".
const SIBLING_FRAMING = /human-led[^.\n]*sibling of[^.\n]*qa-explore/i;

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function* walkTextFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walkTextFiles(full);
      continue;
    }
    if (entry.isFile() && /\.(md|mdx|json|txt)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe('qa-assist rename / cutover guard', () => {
  it('ships the human-led /qa-assist workflow and its generated command', async () => {
    assert.equal(
      await fileExists(path.join(REPO_ROOT, ASSIST_WORKFLOW)),
      true,
      `${ASSIST_WORKFLOW} must exist — it owns the human-led QA flow`,
    );
    assert.equal(
      await fileExists(path.join(REPO_ROOT, ASSIST_COMMAND)),
      true,
      `${ASSIST_COMMAND} must exist — re-run \`npm run sync:commands\``,
    );
  });

  it('keeps /qa-explore present and declares it agent-led, not human-driven', async () => {
    const explorePath = path.join(REPO_ROOT, EXPLORE_WORKFLOW);
    assert.equal(
      await fileExists(explorePath),
      true,
      `${EXPLORE_WORKFLOW} must exist`,
    );
    const source = await readFile(explorePath, 'utf8');
    assert.match(
      source,
      /agent-led/i,
      'qa-explore workflow must frame itself as agent-led',
    );
    assert.match(
      source,
      /no human-driven flow lives in `\/qa-explore`|no human-driven flow lives here/i,
      'qa-explore workflow must disclaim any human-driven flow (it lives in /qa-assist)',
    );
  });

  it('no tracked .agents/, docs/, or .claude/ file asserts /qa-explore is human-driven', async () => {
    const offenders = [];
    for (const root of SCAN_ROOTS) {
      for await (const file of walkTextFiles(root)) {
        if (file === SELF) continue;
        let source;
        try {
          source = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const lines = source.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes('qa-explore')) continue;
          if (!HUMAN_DRIVEN_DESCRIPTORS.test(line)) continue;
          // Permit disclaimers ("no human-driven flow lives in /qa-explore").
          if (DISCLAIMER.test(line)) continue;
          // Permit the sibling framing, where the human-led descriptor
          // qualifies /qa-assist (the human-led sibling), not qa-explore:
          //   - same line names qa-assist, OR
          //   - the construction "human-led sibling of `/qa-explore`" (the
          //     descriptor binds to the sibling, with qa-explore as the object
          //     of "sibling of").
          if (line.includes('qa-assist')) continue;
          if (SIBLING_FRAMING.test(line)) continue;
          offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Found tracked file(s) that still describe /qa-explore as human-driven (it is agent-led; the human-led flow is /qa-assist):\n${offenders.join('\n')}`,
    );
  });
});
