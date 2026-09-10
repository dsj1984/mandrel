/**
 * tests/bootstrap/story-worker-dispatch-guidance.test.js — the worker's
 * long-command dispatch contract.
 *
 * A `story-worker` boots on its own system prompt with no `CLAUDE.md` /
 * `instructions.md` closure, so anything it is not told — or cannot reach
 * from its own boot context — it improvises. The credited full-suite run is
 * the longest command in a worker's life and routinely outruns the host's
 * synchronous Bash ceiling, and improvised waiters are buggy in ways that
 * outlive the agent that spawned them.
 *
 * `parallel-tooling.md` Rule 2 has always carried the correct pattern, but
 * it sat outside the worker's reachable closure: `story-worker.md` cited no
 * dispatch guidance at all, and `deliver-story.md` declares `deliver-digest.md`
 * as its only mandatoryRead. This test pins the reachability — the citation
 * is the durable fix, so a later edit that deletes it fails here rather than
 * silently returning every worker to improvising.
 *
 * ## What this guard is allowed to pin (Story #5284)
 *
 * The boot context is 7.9 KB against an 8 KB ceiling, so every worker-side
 * edit is a rewrite under pressure — and this file had grown seven
 * verbatim-phrase assertions against it. That is a guard asserting the
 * *wording* rather than the contract: a rewrite that says the same thing in
 * fewer bytes reds here, which makes the ceiling unmeetable and the guard the
 * thing that gets deleted.
 *
 * So the durable claims are tested structurally — the section exists, it
 * cites `parallel-tooling.md` Rule 2, it names background dispatch, and it no
 * longer carries the retired instruction — and the verbatim pins are capped
 * at {@link MAX_EXACT_SENTENCE_PINS}, declared in one list so the cap is
 * enforced rather than merely intended. The two that survive are the ones
 * with no structural proxy: a prohibition and a generalisation, neither of
 * which can be inferred from the presence of a heading.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import initCheck from '../../.agents/scripts/lib/checks/story-init-not-backgrounded.js';
import { assertDocMentions, assertDocOmits } from '../helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const WORKER = '.agents/agents/story-worker.md';
const RULE2 = '.agents/workflows/helpers/parallel-tooling.md';
const DIGEST = '.agents/workflows/helpers/deliver-digest.md';

/** The per-agent boot ceiling `check-context-budget.js` enforces. */
const AGENT_BOOT_CEILING_BYTES = 8192;

/**
 * The worker's credited-run section: from its `## Close gates` heading to the
 * next `##` heading. Scoping the assertions to this section is what makes
 * them meaningful — guidance parked in an unrelated section would not reach
 * a worker at the moment it is about to launch the suite.
 */
function creditedRunSection(src) {
  const start = src.indexOf('## Close gates');
  assert.notEqual(start, -1, `${WORKER} has no "## Close gates" section`);
  const rest = src.slice(start + 3);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The verbatim sentences this guard is allowed to require of the worker's
 * boot context, and the cap on how many there may be.
 *
 * Each earns its place by having no structural proxy: nothing about the
 * shape of the section says "do not spawn a waiter", and nothing says "a zero
 * exit is not evidence". Everything else the section must convey is asserted
 * by presence, citation or omission below.
 */
const MAX_EXACT_SENTENCE_PINS = 2;

const EXACT_SENTENCE_PINS = Object.freeze([
  {
    pattern: /Never spawn a task to poll/i,
    why: 'the prohibition on a waiter task — improvised waiters outlive the agent that spawned them',
  },
  {
    pattern: /exit code is never evidence a gate did work/i,
    why: 'the generalisation past this one command: a zero exit is not evidence the gate ran',
  },
]);

describe('story-worker carries a reachable long-command dispatch contract', () => {
  it('pins no more verbatim sentences than the cap allows', () => {
    assert.ok(
      EXACT_SENTENCE_PINS.length <= MAX_EXACT_SENTENCE_PINS,
      `this guard may pin at most ${MAX_EXACT_SENTENCE_PINS} exact sentences of ${WORKER}; pinning more makes the 8 KB boot ceiling unmeetable, because every rewording reds a guard instead of the contract`,
    );
  });

  it('carries each pinned sentence verbatim', () => {
    const section = creditedRunSection(read(WORKER));
    for (const { pattern, why } of EXACT_SENTENCE_PINS) {
      // `assertDocMentions` normalises the doc's own line wrapping, so a pin
      // survives a reflow that changes nothing it asserts.
      assertDocMentions(
        section,
        pattern,
        `the credited-run section must carry ${why}`,
      );
    }
  });

  it('has a credited-run section at all', () => {
    // `creditedRunSection` asserts the heading exists, and a section that
    // collapsed to its heading would satisfy every loose match below.
    const section = creditedRunSection(read(WORKER));
    assert.ok(
      section.trim().length > 200,
      'the credited-run section must carry substance, not just a heading',
    );
  });

  it('tells the worker to dispatch the credited suite in the background', () => {
    const section = creditedRunSection(read(WORKER));
    assert.match(
      section,
      /background/i,
      'the credited-run section must name background dispatch — without it a worker holds the turn open until the host kills it',
    );
    assert.match(
      section,
      /re-invokes|notification/i,
      'the credited-run section must say the completion notification is the proceed signal',
    );
  });

  it('forbids waiting on that run with a polling loop', () => {
    const section = creditedRunSection(read(WORKER));
    assert.match(
      section,
      /sleep/i,
      'the credited-run section must name the sleep-loop shape it forbids',
    );
  });

  it('reaches parallel-tooling Rule 2 from the boot context itself', () => {
    const section = creditedRunSection(read(WORKER));
    assert.match(
      section,
      /parallel-tooling\.md/,
      'the credited-run section must cite parallel-tooling.md — the reachability gap, not the absent prose, is what made every worker re-solve this',
    );
    assert.match(
      section,
      /Rule 2/,
      'the citation must name Rule 2, the long-shell dispatch rule',
    );
  });

  it('names the skip as a legitimate outcome of the credited run', () => {
    // `coverage-capture.js` delegates to the incremental path, which by design
    // runs nothing when the change set touches no crap `targetDirs` entry — a
    // docs- or tests-only Story hits it every time. Unstated, the worker reads
    // the zero exit as a green suite it never ran.
    const section = creditedRunSection(read(WORKER));
    assertDocMentions(
      section,
      /run nothing|runs nothing|skips? capture/i,
      'the credited-run section must say the command can run no test at all',
    );
  });

  it('routes that verdict through the output, never the exit status', () => {
    const section = creditedRunSection(read(WORKER));
    assertDocMentions(
      section,
      /\*\*output\*\*/,
      'the section must name the output as what says whether the run deposited credit',
    );
  });

  it('sends an uncredited run back through a scoped suite, not the whole one', () => {
    const section = creditedRunSection(read(WORKER));
    assertDocMentions(
      section,
      /credit/i,
      'the section must name the credit outcome the worker has to act on',
    );
    assertDocMentions(
      section,
      /scoped/i,
      'a skip must still end in a verified claim — for the files that changed. The whole suite is what the skip already established was unnecessary',
    );
    assertDocOmits(
      section,
      /run the full suite yourself/i,
      'the retired instruction: a docs/CI-only Story paid minutes of whole-suite time that a scoped run covers in seconds',
    );
  });

  it('keeps the boot context inside its per-agent ceiling', () => {
    const bytes = Buffer.byteLength(read(WORKER), 'utf8');
    assert.ok(
      bytes <= AGENT_BOOT_CEILING_BYTES,
      `${WORKER} is ${bytes} bytes, over the ${AGENT_BOOT_CEILING_BYTES}-byte per-agent ceiling`,
    );
  });
});

describe('Rule 2 records the waiter traps a worker would otherwise re-discover', () => {
  const rule2 = () => read(RULE2);

  it('records the inverted-until and pgrep self-match shapes', () => {
    const src = rule2();
    assert.match(
      src,
      /until/,
      'Rule 2 must record the `until` guard that inverts to permanently-false on success',
    );
    assert.match(
      src,
      /pgrep -f/,
      "Rule 2 must record `pgrep -f` matching the waiter's own command line",
    );
  });

  it('names a safe form for a wait that genuinely must happen', () => {
    const src = rule2();
    assert.match(
      src,
      /kill -0/,
      'Rule 2 must name holding the PID and testing `kill -0` as the safe alternative',
    );
    assert.match(
      src,
      /\[[a-z]\][a-z-]*\.js/,
      'Rule 2 must name the bracketed-pattern form that breaks the self-match',
    );
  });
});

describe('the bundled delivery read pins the same dispatch shape', () => {
  it('names background dispatch in the credited-full-suite section', () => {
    const src = read(DIGEST);
    const start = src.indexOf('## 5.');
    assert.notEqual(start, -1, `${DIGEST} has no "## 5." section`);
    const rest = src.slice(start + 3);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);
    assert.match(
      section,
      /background/i,
      'digest § 5 must name background dispatch — it is the one bundled read every delivery performs, so it covers the path where role-scoped agents are disabled',
    );
  });

  it('names the legitimate skip in the credited-full-suite section', () => {
    const src = read(DIGEST);
    const start = src.indexOf('## 5.');
    assert.notEqual(start, -1, `${DIGEST} has no "## 5." section`);
    const rest = src.slice(start + 3);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);
    assertDocMentions(
      section,
      /capture skips/i,
      'digest § 5 must name the skip — the digest is the only delivery read on the path where role-scoped agents are disabled',
    );
    assertDocMentions(
      section,
      /output.*not the exit code/i,
      'digest § 5 must route the verdict through the output rather than the exit code',
    );
    assertDocMentions(
      section,
      /Run the scoped projects for the roots you changed plus `verify\[\]`/i,
      'digest § 5 must send a skipped run back through the scoped projects plus verify[], not the whole suite',
    );
    assertDocOmits(
      section,
      /run the suite yourself/i,
      'the retired instruction — see the worker-side pin above',
    );
  });
});

describe('the new guidance does not trip the init-backgrounding guard', () => {
  it('reports no story-init-not-backgrounded finding for .agents/', () => {
    const finding = initCheck.detect({ cwd: REPO_ROOT });
    assert.equal(
      finding,
      null,
      `the guard flags a backgrounding token within 20 lines of a story-init.js reference; it reported: ${JSON.stringify(finding)}`,
    );
  });
});
