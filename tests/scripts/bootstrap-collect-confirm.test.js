/** collectAndConfirm: project display branches, missing answers, opt-ins. */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Logger } from '../../.agents/scripts/lib/Logger.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const url = (rel) => pathToFileURL(path.resolve(ROOT, rel)).href;
const SUT_URL = url('.agents/scripts/bootstrap.js');
const GH_EXEC_URL = url('.agents/scripts/lib/gh-exec.js');
const GH_LIST_URL = url('.agents/scripts/lib/bootstrap/gh-list.js');

let seq = 0;

async function loadSut(t, { projects = [] } = {}) {
  const listCalls = [];
  const { default: _default, ...realGh } = await import(GH_EXEC_URL);
  t.mock.module(GH_EXEC_URL, {
    namedExports: { ...realGh, exec: async () => ({ stdout: '{}' }) },
  });
  t.mock.module(GH_LIST_URL, {
    namedExports: {
      listRepos: () => [],
      listProjects: (args) => {
        listCalls.push(args);
        return projects;
      },
    },
  });
  const info = [];
  const errors = [];
  t.mock.method(Logger, 'info', (m) => info.push(String(m)));
  t.mock.method(Logger, 'error', (m) => errors.push(String(m)));
  seq += 1;
  const mod = await import(`${SUT_URL}?t=cac-display-${seq}`);
  return { mod, info, errors, listCalls };
}

function state(flags) {
  return {
    flags: { repo: 'widget', 'base-branch': 'main', ...flags },
    interactive: false,
    assumeYes: false,
    defaults: { owner: 'acme', repo: 'widget', baseBranch: 'main' },
    silentAccept: [],
    gitInitialized: true,
  };
}

const summaryOf = (info) => info.find((l) => l.includes('Review choices'));

describe('collectAndConfirm — project display', () => {
  it('names an existing project by its picker label', async (t) => {
    const { mod, info } = await loadSut(t, {
      projects: [{ value: '7', label: 'Roadmap (#7)' }],
    });
    const res = await mod.collectAndConfirm(
      state({ owner: 'acme', 'project-number': '7' }),
    );
    assert.equal(res.ok, true);
    assert.match(summaryOf(info), /Project V2 name {2}Roadmap\n/);
    assert.match(summaryOf(info), /Project V2 # {5}7/);
  });

  it('keeps a label without a number suffix verbatim', async (t) => {
    const { mod, info } = await loadSut(t, {
      projects: [{ value: '7', label: 'Roadmap' }],
    });
    await mod.collectAndConfirm(
      state({ owner: 'acme', 'project-number': '7' }),
    );
    assert.match(summaryOf(info), /Project V2 name {2}Roadmap\n/);
  });

  it('shows (unknown) for an unmatched number', async (t) => {
    const { mod, info } = await loadSut(t);
    await mod.collectAndConfirm(
      state({ owner: 'acme', 'project-number': '9' }),
    );
    assert.match(summaryOf(info), /Project V2 name {2}\(unknown\)/);
  });

  it('shows (unknown) without listing projects under --skip-github', async (t) => {
    const { mod, info, listCalls } = await loadSut(t);
    await mod.collectAndConfirm(
      state({ owner: 'acme', 'project-number': '9', 'skip-github': true }),
    );
    assert.match(summaryOf(info), /Project V2 name {2}\(unknown\)/);
    assert.equal(listCalls.length, 0);
  });

  it('marks a typed project name as new', async (t) => {
    const { mod, info } = await loadSut(t);
    const res = await mod.collectAndConfirm(
      state({ owner: 'acme', 'project-number': 'Road map' }),
    );
    assert.equal(res.payload.creation.newProject, true);
    assert.match(
      summaryOf(info),
      /Project V2 name {2}Road map {2}will be created/,
    );
    assert.match(summaryOf(info), /Project V2 # {5}\(new\)/);
  });

  it('shows (skip) when no project is given', async (t) => {
    const { mod, info } = await loadSut(t);
    await mod.collectAndConfirm(state({ owner: 'acme', 'project-number': '' }));
    assert.match(summaryOf(info), /Project V2 # {5}\(skip\)/);
  });
});

describe('collectAndConfirm — exits and opt-ins', () => {
  it('exits 1 naming the missing required answers', async (t) => {
    const { mod, errors } = await loadSut(t);
    const s = state({});
    s.defaults = { owner: null, repo: null, baseBranch: 'main' };
    s.flags = { 'base-branch': 'main' };
    const res = await mod.collectAndConfirm(s);
    assert.deepEqual(res, { ok: false, exit: 1 });
    assert.match(errors.join('\n'), /missing required answers: owner, repo/);
  });

  it('resolves opt-ins from flags under --dry-run, defaulting off', async (t) => {
    const { mod } = await loadSut(t);
    const res = await mod.collectAndConfirm(
      state({ owner: 'acme', 'dry-run': true, 'with-quality': true }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.withProjectBoard, false);
    assert.equal(res.payload.withIssueForms, false);
    assert.equal(res.payload.withQuality, true);
  });

  it('declines each opt-in by default when prompting non-interactively', async (t) => {
    const { mod } = await loadSut(t);
    const res = await mod.collectAndConfirm(
      state({ owner: 'acme', 'with-issue-forms': true }),
    );
    assert.deepEqual(
      [
        res.payload.withProjectBoard,
        res.payload.withIssueForms,
        res.payload.withQuality,
      ],
      [false, true, false],
    );
  });
});
