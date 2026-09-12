/**
 * plan-critics-workflow.test.js — the /mandrel-plan critic contract, both halves.
 *
 * Structural half: the deleted `helpers/plan-epic.md` workflow used to host
 * the planning critics; Stage 3 collapsed `/mandrel-plan` to one `mandrel-plan.md` path and
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
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
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
    path.join(REPO_ROOT, '.agents', 'workflows', 'mandrel-plan.md'),
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

describe('/mandrel-plan critic workflow — retired helper surface stays gone', () => {
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

describe('/mandrel-plan critic workflow — the pre-mortem is operator-invoked, not a spine step (Story #5312)', () => {
  it('carries no step 2.5 and names plan-critics.js only as an operator-requested run', () => {
    assert.doesNotMatch(planSource, /### 2\.5/);
    assert.doesNotMatch(planSource, /node \.agents\/scripts\/plan-critics\.js/);
    assert.match(planSource, /pre-mortem/);
    assert.match(planSource, /only when the operator asks/);
  });

  it('Gate #1 stops for the sharpened intent and HITL unknowns only, with the offers on one advisory line', () => {
    const interrogate = section('### 1\\. Interrogate');
    assert.match(interrogate, /\*\*Gate #1\*\*/);
    assert.match(interrogate, /exactly two things/);
    assert.match(interrogate, /sharpened plan intent/);
    assert.match(interrogate, /HITL unknown/);
    assert.match(interrogate, /\*\*one advisory line\*\*/);
    assert.doesNotMatch(interrogate, /deliverLightSuggestion/);
    assert.doesNotMatch(planSource, /lite route/);
  });
});

describe('/mandrel-plan critic workflow — persist no longer evaluates critics', () => {
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
    fixtureDir = makeTempDir('plan-critics-');
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
    assert.equal(typeof verdict.premortem.dispatch, 'boolean');
    assert.ok(Array.isArray(verdict.premortem.reasons));
    assert.ok(verdict.premortem.reasons.length > 0);
    // Story #5312: the pre-mortem is the only arm — no consolidation verdict,
    // no text-hygiene entry (open questions are a persist dry-run warning).
    assert.equal('consolidation' in verdict, false);
    assert.equal('textHygiene' in verdict, false);
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
    const empty = makeTempDir('plan-critics-nopkg-');
    try {
      assert.deepEqual(await collectRepoPackages({ rootDir: empty }), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('collects the own name and every dependency map', async () => {
    const root = makeTempDir('plan-critics-deps-');
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
    const glob = makeTempDir('plan-critics-ws-');
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
    const lit = makeTempDir('plan-critics-lit-');
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
    dir = makeTempDir('plan-critics-unit-');
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

  it('records a skipped pre-mortem on the ledger under the CLI name', async () => {
    const draft = [story('solo')];
    const storiesPath = write('match-stories.json', draft);
    const appended = [];

    const verdict = await evaluateCriticArtifacts({
      storiesPath,
      config: {},
      append: async (entry) => {
        appended.push(entry);
        return true;
      },
    });

    assert.equal(verdict.premortem.dispatch, false);
    assert.deepEqual(
      appended.map((e) => e.critic),
      ['pre-mortem'],
    );
    for (const entry of appended) {
      assert.equal(entry.cli, PLAN_CRITICS_CLI);
      assert.ok(entry.reasons.length > 0);
    }
  });

  it('records no skip for a critic that fires', async () => {
    const storiesPath = write('risky-stories.json', [
      {
        slug: 'a',
        depends_on: [],
        body: '## Goal\nNeeds the @beestera/assets package.\n',
      },
    ]);
    const appended = [];

    const verdict = await evaluateCriticArtifacts({
      storiesPath,
      // The external-dependency probe is the pre-mortem's one trigger
      // (Story #5312): an undeclared scoped package fires it.
      config: {},
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
});
