// tests/agents/role-scoped-boot-context.test.js
//
// DEFAULT-VALUE GATE (Epic #4478, M7-B). The adopted design ships
// `delivery.routing.roleScopedAgents` defaulting to TRUE — but ONLY if the
// role-scoped boot context can safely carry the load-bearing delivery MUSTs a
// worker booting on the diet relies on. A byte-size assertion is explicitly NOT
// sufficient, so these tests DRIVE A REAL MATERIALIZATION of the role defs (the
// exact `.claude/agents/*.md` a host boots on), assemble the full boot context a
// worker runs on (role body + the resolved `@`-imported security-baseline), and
// assert every MUST survives:
//
//   story-worker:      creates + verifies its branch, hits the close gate list,
//                      can transition agent::blocked, and lands only via the
//                      sanctioned close path (#4483). (The story.heartbeat MUST
//                      was dropped in A22 — its emitter was structurally inert
//                      and has been deleted; agent::blocked is the real signal.)
//   acceptance-critic: is maker-blind and emits a schema-VALID verdict against
//                      acceptance-eval-verdict.schema.json.
//
// If any MUST were missing from the boot context, a worker booting on the diet
// would silently drop it → the default must be false. These tests are the gate
// the PR keys the default-true decision on.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test, { before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { assertDocMentions, assertDocOmits } from '../helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNC_SCRIPT = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'sync-claude-agents.js',
);

// Drive a REAL materialization into an isolated temp dest (the exact code path
// `npm run sync:agents` / the postinstall bootstrap runs), so we validate the
// projected boot context, not the hand-authored source.
let destDir;
/** @type {Map<string, string>} */
const materialized = new Map();

/**
 * Resolve the role def's `@`-import against the CANONICAL host location
 * (`<repo>/.claude/agents/<file>`) — where a host actually boots the agent —
 * and return the absolute path the import points at. This proves the import
 * FORM is correct for real-host resolution regardless of where the test
 * materialized the fixture copy.
 */
function resolveImportFromHostLocation(fileName, importSpec) {
  const hostFile = path.join(REPO_ROOT, '.claude', 'agents', fileName);
  return path.resolve(path.dirname(hostFile), importSpec);
}

before(() => {
  destDir = makeTempDir('m7b-agents-');
  const result = spawnSync(process.execPath, [SYNC_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, SYNC_CLAUDE_AGENTS_DEST: destDir },
  });
  assert.equal(
    result.status,
    0,
    `sync-claude-agents.js failed: ${result.stderr}`,
  );
  for (const name of readdirSync(destDir).filter((f) => f.endsWith('.md'))) {
    materialized.set(name, readFileSync(path.join(destDir, name), 'utf8'));
  }
});

/**
 * Assemble the FULL boot context a role agent runs on: the materialized role
 * body plus the resolved content of its `@`-imported security-baseline. This is
 * the context a real spawn boots on — no CLAUDE.md closure — so asserting a MUST
 * is present here proves the worker still carries it on the diet.
 */
function bootContext(fileName) {
  const body = materialized.get(fileName);
  assert.ok(body, `${fileName} was not materialized`);
  const m = body.match(/^@(\S+)/m);
  assert.ok(m, `${fileName} has no @-import line`);
  const importAbs = resolveImportFromHostLocation(fileName, m[1]);
  assert.ok(
    existsSync(importAbs),
    `${fileName} @-import ${m[1]} does not resolve from the host .claude/agents/ location`,
  );
  assert.equal(
    importAbs,
    path.join(REPO_ROOT, '.agents', 'rules', 'security-baseline.md'),
    `${fileName} @-import must resolve to the real security-baseline.md`,
  );
  const imported = readFileSync(importAbs, 'utf8');
  return { body, imported, combined: `${body}\n${imported}` };
}

describe('story-worker boot context carries every delivery MUST (default-true gate)', () => {
  test('the @-import resolves to the real security-baseline from the host location', () => {
    const { imported } = bootContext('story-worker.md');
    // The inviolable security core is present in the booted context.
    assert.match(imported, /MUST/);
    assert.match(imported, /secret/i);
  });

  test('creates AND verifies its branch before committing', () => {
    const { body } = bootContext('story-worker.md');
    assert.match(body, /story-init\.js/); // branch creation
    assert.match(body, /branch --show-current/); // verify-branch step
    assert.match(body, /story-<storyId>/); // the expected branch name
    assert.match(body, /before .*commit/i); // verify BEFORE committing
  });

  test('carries the full close gate list', () => {
    const { body } = bootContext('story-worker.md');
    for (const gate of [
      'typecheck',
      'lint',
      'test',
      'format',
      'maintainability',
      'coverage',
      'crap',
    ]) {
      assert.match(
        body.toLowerCase(),
        new RegExp(gate),
        `close gate "${gate}" missing from the boot context`,
      );
    }
  });

  test('carries both crediting invocations of the one full-suite run (#5174)', () => {
    // The invocation used to live only in deliver-story-reference.md — a file
    // a dispatched worker is told NOT to read on the happy path. So every
    // worker ran the suite in the shape that earns no credit, and close ran
    // the identical suite again. The instruction has to reach the file the
    // worker actually boots on.
    const { body } = bootContext('story-worker.md');
    assert.match(
      body,
      /scripts\/coverage-capture\.js --cwd <workCwd>/,
      'the boot context must carry the coverage-capture crediting invocation',
    );
    assert.match(
      body,
      /scripts\/evidence-gate\.js --standalone/,
      'the boot context must carry the evidence-gate alternative for repos with no capture stamp',
    );
    assertDocMentions(
      body,
      /--gate test --worktree <workCwd> -- npm test/,
      'the evidence-gate alternative must be complete enough to run verbatim',
    );
  });

  test('names the shape that deposits no credit (#5174)', () => {
    assertDocMentions(
      bootContext('story-worker.md').body,
      /bare `npm test` \/ `pnpm run test` deposits \*\*no\*\* credit/,
      'the boot context must say plainly which invocation earns nothing',
    );
  });

  test('permits the credited run without licensing ad-hoc stamping (#5174)', () => {
    // The reconciliation this Story exists for: the old paragraph told the
    // worker never to stamp coverage/CRAP fresh at all, which reads as a
    // prohibition on the very invocation the digest now mandates. Appending
    // the new text would have left the worker holding both. Assert the
    // contradiction is gone AND that the narrow prohibition survives — a
    // rewrite that dropped the second half would license a hand-rolled
    // coverage record, which silently weakens the floor.
    const { body } = bootContext('story-worker.md');
    assertDocOmits(
      body,
      /never stamp coverage \/ CRAP fresh that way/,
      'the blanket prohibition contradicts the credited invocation — it must be rewritten, not kept alongside it',
    );
    assertDocMentions(
      body,
      /never stamp coverage \/ CRAP fresh any other way/,
      'ad-hoc coverage/CRAP stamping must still be forbidden outside the credited invocation',
    );
    // Story #5267 flipped this ordering. The stamp is keyed on the tree, not
    // on push state, so the push does not spend it — while capturing first
    // does spend the push: the capture is backgrounded, and its completion
    // notification is what ends the worker's turn.
    assertDocMentions(
      body,
      /run it exactly once, after the self-eval loop's last fix commit and immediately after the push/,
      'the boot context must place the credited run after the push, where the turn cannot end before the branch is on origin',
    );
    assertDocOmits(
      body,
      /immediately before the push/,
      'no surviving instruction may tell the worker to capture before pushing',
    );
  });

  test('can transition agent::blocked and never falls silent', () => {
    const { body } = bootContext('story-worker.md');
    assert.match(body, /agent::blocked/);
    assert.match(body, /exit non-zero/i);
    assert.match(body, /[Nn]ever fall silent/);
  });

  test('lands only via the sanctioned close path (#4483 land-or-block)', () => {
    const { body } = bootContext('story-worker.md');
    assert.match(body, /#4483|[Ll]and or block/);
    assert.match(body, /remoteVerified/);
    assert.match(body, /story-close\.js/); // the only sanctioned landing
  });

  test('returns a hand-off, and never hand-composes a terminal envelope', () => {
    // Story #4543 — this used to assert the boot context declared its OWN
    // `"state"` field. That was the bug: `helpers/deliver-story.md` declared a
    // different shape, neither was validated, and the two drifted. Story #4876
    // then moved the close-and-land tail off the worker entirely, so the
    // envelope contract moved with it (asserted over the orchestrator spines in
    // the suite below); what the worker still owes is a hand-off it can back.
    const { body } = bootContext('story-worker.md');
    assertDocMentions(
      body,
      /hand-off/i,
      'story-worker.md must define the hand-off it returns in place of an envelope',
    );
    assertDocMentions(
      body,
      /[Nn]ever hand-compose a terminal envelope/,
      'story-worker.md must forbid inventing an envelope it did not receive',
    );
    assertDocMentions(
      body,
      /pushed head SHA/i,
      'the hand-off must name the pushed head SHA the orchestrator closes',
    );
  });

  test('does not re-declare the terminal envelope as its own JSON shape', () => {
    // The guard that keeps the duplication from growing back: a JSON block
    // naming the envelope's own fields means someone re-forked the contract.
    const { body } = bootContext('story-worker.md');
    assert.doesNotMatch(
      body,
      /"(status|state)"\s*:\s*"(done|landed)/,
      'story-worker.md restates the terminal envelope — reference the schema instead',
    );
  });

  test('enforces absolute paths (cwd may reset between calls)', () => {
    const { body } = bootContext('story-worker.md');
    assert.match(body, /[Aa]bsolute path/);
  });

  test('ends its turn at a pushed branch and does not own the tail (#4876)', () => {
    // #4816 put "hold the turn until the envelope arrives" here, and it did not
    // hold: three of five workers in one measured wave backgrounded close and
    // ended the turn anyway, and a sub-agent gets no notification to resume
    // itself. #4876 moved the seam instead of re-wording the prohibition — the
    // worker stops at a pushed branch and the orchestrator runs close. The
    // foreground/never-background wording moved with the responsibility; it is
    // asserted over the orchestrator spines in the suite below.
    const { body } = bootContext('story-worker.md');
    assertDocMentions(
      body,
      /You do \*\*not\*\* run close/,
      'story-worker.md must say plainly that the worker does not run close',
    );
    assertDocMentions(
      body,
      /[Pp]ush `story-<storyId>` to `origin`/,
      'story-worker.md must define the hand-off point as a pushed branch',
    );
    assertDocMentions(
      body,
      /serialized/i,
      'story-worker.md must say the orchestrator serializes the tail',
    );
    assert.doesNotMatch(
      body,
      /never end your turn while it is still running/i,
      'the close-turn MUST belongs to the orchestrator now, not the worker',
    );
  });
});

describe('the close-and-land tail belongs to the orchestrator (Story #4876)', () => {
  const spine = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const DELIVER = '.agents/workflows/mandrel-deliver.md';
  const DELIVER_STORY = '.agents/workflows/helpers/deliver-story.md';

  test(`${DELIVER_STORY} assigns Step 3 to the dispatching orchestrator`, () => {
    const body = spine(DELIVER_STORY);
    assertDocMentions(
      body,
      /Step 3 belongs to the orchestrator/i,
      'the engine must name who owns the close step',
    );
    assertDocMentions(
      body,
      /never to a spawned worker/i,
      'the engine must exclude the worker from the tail',
    );
  });

  test(`${DELIVER_STORY} keeps the foreground-close MUST, relocated (#4816)`, () => {
    // These phrases were pinned on story-worker.md until #4876. They did not
    // disappear — they moved to the role that now runs close.
    const body = spine(DELIVER_STORY);
    assertDocMentions(body, /foreground/i, 'close must run in the foreground');
    assertDocMentions(
      body,
      /[Nn]ever background it/,
      'backgrounding the close must stay forbidden',
    );
    assertDocMentions(
      body,
      /never delegate it to a child/i,
      'delegating the close to a child must stay forbidden',
    );
    assertDocMentions(
      body,
      /never end your turn while it is still running/i,
      'ending the turn mid-close must stay forbidden',
    );
    assertDocMentions(
      body,
      /story-deliver-terminal-<storyId>\.json/,
      'the persisted envelope fallback must stay named',
    );
  });

  test(`${DELIVER_STORY} still points at the terminal-envelope schema`, () => {
    const body = spine(DELIVER_STORY);
    assert.match(body, /story-deliver-terminal\.schema\.json/);
    for (const status of ['landed', 'pending', 'blocked', 'failed']) {
      assert.match(body, new RegExp(status));
    }
  });

  test(`${DELIVER} serializes the tail across concurrently delivered Stories`, () => {
    const body = spine(DELIVER);
    assertDocMentions(
      body,
      /Serialize the tail/i,
      '/mandrel-deliver must state that the tail is serialized',
    );
    assertDocMentions(
      body,
      /one Story at a time/i,
      '/mandrel-deliver must cap the tail at one close',
    );
    assertDocMentions(
      body,
      /[Ii]mplementation runs in parallel/,
      '/mandrel-deliver must contrast parallel implementation with a serial tail',
    );
  });

  test('an envelope-less worker return is documented as expected, not a re-dispatch', () => {
    for (const rel of [DELIVER, DELIVER_STORY]) {
      const body = spine(rel);
      assertDocMentions(
        body,
        /returning no terminal envelope is (?:the )?expected/i,
        `${rel} must name the envelope-less return as expected`,
      );
      assertDocMentions(
        body,
        /deliver-recover\.js/,
        `${rel} must route recovery through the read-only probe`,
      );
      assertDocMentions(
        body,
        /(?:[Nn]ever re-dispatch the Story|not a failure to answer with a re-dispatch)/,
        `${rel} must forbid re-dispatching the Story on a missing envelope`,
      );
    }
  });
});

describe('acceptance-critic boot context produces a valid maker-blind verdict (default-true gate)', () => {
  test('is maker-blind — never grades the maker’s self-assessment', () => {
    const { body } = bootContext('acceptance-critic.md');
    assert.match(body, /maker-blind/i);
    assert.match(body, /must not/i);
    // Grades the work product, not the maker's narration.
    assert.match(body, /self-assessment|narration|homework/i);
  });

  test('scores a cluster it is handed — never decides the cluster count', () => {
    const { body } = bootContext('acceptance-critic.md');
    assert.match(body, /cluster/i);
    assert.match(body, /the caller owns clustering/i);
    assert.match(body, /never|not.*re-slice|do not.*re-slice/i);
  });

  test('references the verdict schema the gate consumes', () => {
    const { body } = bootContext('acceptance-critic.md');
    assert.match(body, /acceptance-eval-verdict\.schema\.json/);
  });

  test('a verdict of the shape the boot context specifies validates against the schema', () => {
    // The role def instructs the critic to emit this shape; prove a conforming
    // maker-blind verdict actually passes the schema the gate enforces.
    const schema = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          '.agents',
          'schemas',
          'acceptance-eval-verdict.schema.json',
        ),
        'utf8',
      ),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const makerBlindVerdict = {
      storyId: 4478,
      epicId: 4478,
      schemaVersion: 1,
      round: 1,
      commitSha: 'abc1234',
      criteria: [
        {
          index: 0,
          criterion: 'The role-scoped spawn boots on its own context.',
          verdict: 'met',
          evidence:
            'sync-claude-agents.js materializes .claude/agents/story-worker.md',
          verifyEvidence: [
            { command: 'npm run lint', outcome: 'pass', detail: null },
          ],
        },
      ],
    };
    assert.equal(
      validate(makerBlindVerdict),
      true,
      JSON.stringify(validate.errors),
    );
  });
});
