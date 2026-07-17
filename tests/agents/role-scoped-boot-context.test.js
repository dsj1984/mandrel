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
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
  destDir = mkdtempSync(path.join(tmpdir(), 'm7b-agents-'));
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

  test('references the terminal envelope schema rather than restating its fields', () => {
    // Story #4543 — this used to assert the boot context declared its OWN
    // `"state"` field. That was the bug: `helpers/deliver-story.md` declared a
    // different shape, neither was validated, and the two drifted. The
    // contract now lives in one schema and this file points at it.
    const { body } = bootContext('story-worker.md');
    assert.match(body, /story-deliver-terminal\.schema\.json/);
    assert.match(body, /landed/);
    assert.match(body, /pending/);
    assert.match(body, /blocked/);
    assert.match(body, /failed/);
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
    assert.match(body, /ceil\(totalACs \/ clusterCeiling\)/);
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
