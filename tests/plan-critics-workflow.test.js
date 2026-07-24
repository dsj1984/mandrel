/**
 * plan-critics-workflow.test.js — the /plan critic contract, both halves.
 *
 * Structural half: the deleted `helpers/plan-epic.md` workflow used to host
 * the planning critics; Stage 3 collapsed `/plan` to one `plan.md` path and
 * removed that fork. These assertions keep the old helper surface from
 * reappearing through stale prose.
 *
 * Live half (Story #4592): the critic step is real again, and it sits between
 * Author and Persist — the last point where a finding can be folded into a
 * re-author round instead of into live issues. The `plan-critics.js` CLI is
 * the single evaluation point; persist no longer evaluates critics at all.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderDecomposerSystemPrompt } from '../.agents/scripts/lib/templates/decomposer-prompts.js';
import {
  collectRepoPackages,
  evaluateCriticArtifacts,
  loadCriticArtifacts,
  PLAN_CRITICS_CLI,
} from '../.agents/scripts/plan-critics.js';
import { assertDocMentions, assertDocOmits } from './helpers/doc-assert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, '.agents', 'scripts', 'plan-critics.js');

const planSource = readWorkflow();

function readWorkflow() {
  return fs.readFileSync(
    path.join(REPO_ROOT, '.agents', 'workflows', 'plan.md'),
    'utf8',
  );
}

function section(headingPattern) {
  return (
    planSource.match(
      new RegExp(`${headingPattern}[\\s\\S]*?(?=\\n#{2,3} )`),
    )?.[0] ?? ''
  );
}

/** A draft Story with no `depends_on`. */
function story(slug) {
  return { slug, depends_on: [], body: `## Goal\n${slug}.` };
}

/** A `## Delivery Slicing` table matching `stories` 1:1 (all independent). */
function slicingTableFor(stories) {
  return [
    '## Delivery Slicing',
    '',
    '| Slice | What ships | Independent? |',
    '| --- | --- | --- |',
    ...stories.map((s) => `| ${s.slug} | ships ${s.slug} | Yes |`),
  ].join('\n');
}

describe('/plan critic workflow — retired helper surface stays gone', () => {
  it('uses plan.md as the sole planning workflow source', () => {
    assertDocMentions(
      planSource,
      /Single planning path/i,
      'plan.md is the sole planning workflow',
    );
    assertDocMentions(
      planSource,
      /no Epic\/Story router/i,
      'the Epic/Story planning fork is retired',
    );
  });

  it('does not reference deleted planning-fork helper files', () => {
    for (const deleted of [
      'helpers/plan-epic.md',
      'helpers/plan-story.md',
      'helpers/scope-triage-gate.md',
      'helpers/plan-epic-reference.md',
    ]) {
      assert.doesNotMatch(planSource, new RegExp(deleted.replace('.', '\\.')));
    }
  });

  it('does not resurrect the retired epic-scoped critic sub-agents', () => {
    assert.doesNotMatch(planSource, /epic-plan-premortem/);
    assert.doesNotMatch(planSource, /epic-plan-consolidate/);
  });
});

describe('/plan critic workflow — the live pre-persist critic step (#4592)', () => {
  it('runs the plan-critics.js CLI as a real workflow step', () => {
    assert.match(planSource, /node \.agents\/scripts\/plan-critics\.js/);
  });

  it('sites the critic step between the Author and Persist sections', () => {
    const authorIdx = planSource.indexOf('### 2. Author');
    const criticIdx = planSource.indexOf('### 2.5 Critics');
    const persistIdx = planSource.indexOf('### 3. Persist');

    assert.ok(authorIdx > -1, 'plan.md must carry the author step');
    assert.ok(criticIdx > -1, 'plan.md must carry the critic step');
    assert.ok(persistIdx > -1, 'plan.md must carry the persist step');
    assert.ok(
      authorIdx < criticIdx && criticIdx < persistIdx,
      'the critic step must sit between Author and Persist — after persist ' +
        'there is no re-author loop for a dispatch verdict to route to.',
    );
  });

  it('routes a dispatch verdict to a maker-blind fresh-context sub-agent', () => {
    const critics = section('### 2\\.5 Critics');
    assert.match(critics, /dispatch/);
    assert.match(critics, /maker-blind/i);
    assertDocMentions(
      critics,
      /never the authoring transcript/i,
      'the critic is maker-blind — it never sees the authoring transcript',
    );
    // Advisory, not a mechanical gate: the CLI exits 0 on any verdict.
    assertDocMentions(
      critics,
      /exits 0 on \*\*any\*\* verdict/i,
      'the critic CLI exits 0 on any verdict',
    );
  });

  it('names the exit-1 usage/IO case and forbids proceeding to Persist on it', () => {
    // plan-critics.js is advisory only for a *verdict*; a usage/IO error exits
    // 1 having run no critic and ledgered no skip. Documenting that as "always
    // exits 0" (Story #4602) read as "advisory, proceed", so a mistyped
    // --stories path silently persisted with both critics skipped.
    const critics = section('### 2\\.5 Critics');
    assertDocMentions(
      critics,
      /exits \*\*1\*\*/i,
      'a usage/IO error must exit 1',
    );
    assertDocMentions(
      critics,
      /usage\/IO error/i,
      'the exit-1 case must be named as a usage/IO error',
    );
    assertDocOmits(
      critics,
      /always exits 0/i,
      'the CLI does not ALWAYS exit 0 — a usage/IO error exits 1',
    );
    assertDocMentions(
      critics,
      /\*\*do not proceed to Persist\*\*/i,
      'a blocking verdict must stop the run before Persist',
    );
  });

  it('names the external-dependency pre-mortem trigger (#4700)', () => {
    const critics = section('### 2\\.5 Critics');
    assert.match(critics, /external-dependency/);
    assert.match(critics, /pre-mortem/i);
  });

  it('names textHygiene findings as re-author input in the critic step (#4599)', () => {
    // The workflow wires hygiene findings into the re-author round: the
    // critic step must name the verdict entry and route its findings.
    const critics = section('### 2\\.5 Critics');
    assert.match(critics, /textHygiene/);
    assert.match(critics, /textHygiene\.findings\[\]/);
    assertDocMentions(
      critics,
      /re-author round/i,
      'textHygiene findings drive a re-author round',
    );
    assert.match(critics, /advisory-only/i);
  });
});

describe('story-author prompt — codified text-hygiene conventions (#4599)', () => {
  const prompt = renderDecomposerSystemPrompt();

  it('mandates the "Current state (verified <date>)" preamble for observed-behavior claims', () => {
    assertDocMentions(
      prompt,
      /Current state \(verified <date>\)/,
      'the prompt must carry the verified-state template',
    );
  });

  it('mandates the intent-then-proxy acceptance shape', () => {
    assertDocMentions(
      prompt,
      /state the intent clause before the proxy check/i,
      'acceptance criteria lead with intent, not the proxy',
    );
  });

  it('mandates one-line Slicing checkpoints with detail in Spec', () => {
    assertDocMentions(
      prompt,
      /Slicing checkpoints are one line each/i,
      'Slicing rows stay one line each',
    );
    assertDocMentions(
      prompt,
      /detail lives in `## Spec`/i,
      'detail belongs in the folded Spec, not the Slicing rows',
    );
  });

  it('mandates decisions-not-questions bodies with declarative Key Assumptions', () => {
    assertDocMentions(
      prompt,
      /record decisions, never questions to the operator/i,
      'assumptions record decisions, not open questions',
    );
    assertDocMentions(
      prompt,
      /declarative Key Assumption/i,
      'Key Assumptions are declarative',
    );
  });
});

describe('/plan critic workflow — persist no longer evaluates critics', () => {
  const persistSource = fs.readFileSync(
    path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'plan-persist',
      'run-plan-persist.js',
    ),
    'utf8',
  );

  it('has no evaluatePlanCritics call left in the persist pipeline', () => {
    assert.doesNotMatch(persistSource, /evaluatePlanCritics/);
  });

  it('keeps the --force-review gate #2 before plan-persist writes', () => {
    const persist = section('### 3\\. Persist');
    assert.match(persist, /\*\*Gate #2\*\*/);
    assert.match(persist, /`--force-review`/);
    assertDocMentions(
      persist,
      /before persist/i,
      'Gate #2 runs before persist',
    );
    assert.match(persist, /node \.agents\/scripts\/plan-persist\.js/);
  });
});

describe('plan-critics.js CLI — verdict contract', () => {
  let fixtureDir;

  /** Run the CLI against a fixture, isolated onto its own temp ledger root. */
  function runCli(args) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, AP_AGENTRC_CWD: fixtureDir, CI: '1' },
      timeout: 20_000,
    });
  }

  function writeFixture(name, contents) {
    const filePath = path.join(fixtureDir, name);
    fs.writeFileSync(
      filePath,
      typeof contents === 'string' ? contents : JSON.stringify(contents),
    );
    return filePath;
  }

  before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-critics-'));
    // An absolute tempRoot inside the fixture dir keeps every ledger write
    // this suite makes out of the real checkout's temp/ (the shared-cache
    // poisoning class that blocked Story #4555).
    fs.writeFileSync(
      path.join(fixtureDir, '.agentrc.json'),
      JSON.stringify({
        project: {
          paths: {
            agentRoot: '.agents',
            docsRoot: 'docs',
            tempRoot: path.join(fixtureDir, 'temp'),
          },
        },
      }),
    );
  });

  after(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('prints a pure-JSON verdict on stdout and exits 0', () => {
    const storiesPath = writeFixture('stories-dispatch.json', [
      story('s1'),
      story('s2'),
      story('s3'),
      story('s4'),
      story('s5'),
      story('s6'),
    ]);

    const res = runCli(['--stories', storiesPath]);

    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    // Pure JSON: no interleaved log lines. A headless caller parses stdout
    // unconditionally, so this must not need stripping.
    const verdict = JSON.parse(res.stdout);
    assert.equal(typeof verdict.consolidation.dispatch, 'boolean');
    assert.equal(typeof verdict.premortem.dispatch, 'boolean');
    assert.ok(Array.isArray(verdict.consolidation.reasons));
    assert.ok(Array.isArray(verdict.premortem.reasons));
    assert.ok(verdict.consolidation.reasons.length > 0);
    // The advisory text-hygiene entry rides the same verdict JSON (#4599).
    assert.equal(verdict.textHygiene.critic, 'text-hygiene');
    assert.ok(Array.isArray(verdict.textHygiene.findings));
  });

  it('fires consolidation on a draft above the story threshold', () => {
    const storiesPath = writeFixture('stories-over.json', [
      story('s1'),
      story('s2'),
      story('s3'),
      story('s4'),
      story('s5'),
      story('s6'),
    ]);

    const verdict = JSON.parse(runCli(['--stories', storiesPath]).stdout);

    assert.equal(verdict.consolidation.dispatch, true);
    assert.match(verdict.consolidation.reasons.join(' '), /6 stories/);
  });

  it('skips consolidation on a small draft matching its slicing table', () => {
    const draft = [story('only-slice')];
    const storiesPath = writeFixture('stories-match.json', draft);
    const techSpecPath = writeFixture('techspec.md', slicingTableFor(draft));

    const res = runCli(['--stories', storiesPath, '--tech-spec', techSpecPath]);
    const verdict = JSON.parse(res.stdout);

    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(verdict.consolidation.dispatch, false);
    assert.equal(verdict.premortem.dispatch, false);
    assert.match(verdict.consolidation.reasons.join(' '), /1:1/);
  });

  it('exits non-zero on a missing --stories flag', () => {
    const res = runCli([]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--stories/);
  });

  // AC-3 (Story #4700): the external-dependency trigger surfaces end-to-end.
  // The CLI reads the repo's own manifests (mandrel's, at cwd=REPO_ROOT) to
  // tell a local scoped package from an external one, so a single-story draft
  // that names @beestera/assets — a scope no mandrel manifest declares — fires
  // the pre-mortem even though the size and heuristic conditions do not.
  it('fires the pre-mortem on an external scoped-package reference', () => {
    const storiesPath = writeFixture('stories-extdep.json', [
      {
        slug: 'ext-dep',
        depends_on: [],
        body: '## Goal\nBuild the UI once @beestera/assets is published upstream.\n',
      },
    ]);

    const res = runCli(['--stories', storiesPath]);
    const verdict = JSON.parse(res.stdout);

    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(verdict.premortem.dispatch, true);
    assert.match(verdict.premortem.reasons.join(' '), /@beestera\/assets/);
  });
});

describe('plan-critics.js — repo manifest package collection (#4700)', () => {
  it('returns [] when the root has no package.json', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-critics-nopkg-'));
    try {
      assert.deepEqual(await collectRepoPackages({ rootDir: empty }), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('collects the own name and every dependency map', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-critics-deps-'));
    try {
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: '@acme/root',
          dependencies: { '@acme/a': '1.0.0' },
          devDependencies: { '@acme/b': '1.0.0' },
          optionalDependencies: { '@acme/c': '1.0.0' },
          peerDependencies: { '@acme/d': '1.0.0' },
        }),
      );
      const names = await collectRepoPackages({ rootDir: root });
      for (const expected of [
        '@acme/root',
        '@acme/a',
        '@acme/b',
        '@acme/c',
        '@acme/d',
      ]) {
        assert.ok(names.includes(expected), `expected ${expected} in ${names}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a `dir/*` workspace glob one level down', async () => {
    // Fresh root so the glob resolution is the only source of names.
    const glob = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-critics-ws-'));
    try {
      fs.writeFileSync(
        path.join(glob, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      );
      fs.mkdirSync(path.join(glob, 'packages', 'ui'), { recursive: true });
      fs.writeFileSync(
        path.join(glob, 'packages', 'ui', 'package.json'),
        JSON.stringify({ name: '@acme/ui' }),
      );
      const names = await collectRepoPackages({ rootDir: glob });
      assert.ok(names.includes('@acme/ui'));
    } finally {
      fs.rmSync(glob, { recursive: true, force: true });
    }
  });

  it('resolves a literal workspace path and its `{ packages: [] }` shape', async () => {
    const lit = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-critics-lit-'));
    try {
      fs.writeFileSync(
        path.join(lit, 'package.json'),
        JSON.stringify({
          name: 'root',
          workspaces: { packages: ['tools/cli'] },
        }),
      );
      fs.mkdirSync(path.join(lit, 'tools', 'cli'), { recursive: true });
      fs.writeFileSync(
        path.join(lit, 'tools', 'cli', 'package.json'),
        JSON.stringify({ name: '@acme/cli' }),
      );
      const names = await collectRepoPackages({ rootDir: lit });
      assert.ok(names.includes('@acme/cli'));
    } finally {
      fs.rmSync(lit, { recursive: true, force: true });
    }
  });
});

describe('plan-critics.js — artifact loading + skip ledger', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-critics-unit-'));
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name, contents) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(
      filePath,
      typeof contents === 'string' ? contents : JSON.stringify(contents),
    );
    return filePath;
  }

  it('loads stories with an absent tech spec as empty spec text', async () => {
    const storiesPath = write('stories.json', [story('a')]);
    const loaded = await loadCriticArtifacts({ storiesPath });

    assert.equal(loaded.tickets.length, 1);
    assert.equal(loaded.techSpecContent, '');
  });

  it('rejects a stories file that is not a JSON array', async () => {
    const storiesPath = write('object.json', { slug: 'not-an-array' });

    await assert.rejects(() => loadCriticArtifacts({ storiesPath }), {
      message: /must contain a JSON array/,
    });
  });

  it('rejects an unparseable stories file naming the path', async () => {
    const storiesPath = write('broken.json', '{ not json');

    await assert.rejects(() => loadCriticArtifacts({ storiesPath }), {
      message: /Failed to parse .*broken\.json.* as JSON/,
    });
  });

  it('records every skipped critic on the ledger under the CLI name', async () => {
    const draft = [story('solo')];
    const storiesPath = write('match-stories.json', draft);
    const techSpecPath = write('match-spec.md', slicingTableFor(draft));
    const appended = [];

    const verdict = await evaluateCriticArtifacts({
      storiesPath,
      techSpecPath,
      config: {},
      append: async (entry) => {
        appended.push(entry);
        return true;
      },
    });

    assert.equal(verdict.consolidation.dispatch, false);
    assert.equal(verdict.premortem.dispatch, false);
    assert.deepEqual(
      appended.map((e) => e.critic),
      ['consolidation', 'pre-mortem', 'text-hygiene'],
    );
    for (const entry of appended) {
      assert.equal(entry.cli, PLAN_CRITICS_CLI);
      assert.ok(entry.reasons.length > 0);
    }
  });

  it('records no skip for a critic that fires', async () => {
    const storiesPath = write('risky-stories.json', [story('a')]);
    const appended = [];

    const verdict = await evaluateCriticArtifacts({
      storiesPath,
      // A risk-heuristic phrase match is the pre-mortem's other condition;
      // the absent slicing table fails the consolidation precondition open.
      config: { planning: { riskHeuristics: ['## Goal'] } },
      append: async (entry) => {
        appended.push(entry);
        return true;
      },
    });

    assert.equal(verdict.premortem.dispatch, true);
    assert.equal(
      appended.some((e) => e.critic === 'pre-mortem'),
      false,
    );
  });

  it('records no text-hygiene skip when the lint has findings', async () => {
    const storiesPath = write('hygiene-stories.json', [
      {
        slug: 'cited',
        depends_on: [],
        body: '## Goal\nPer the design note (§4, Q5), the gate is dead.\n',
      },
    ]);
    const appended = [];

    const verdict = await evaluateCriticArtifacts({
      storiesPath,
      config: {},
      append: async (entry) => {
        appended.push(entry);
        return true;
      },
    });

    assert.ok(verdict.textHygiene.findings.length > 0);
    assert.equal(
      appended.some((e) => e.critic === 'text-hygiene'),
      false,
    );
  });
});
