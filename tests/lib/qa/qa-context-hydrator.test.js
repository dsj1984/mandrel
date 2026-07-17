import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  collectFeatureFiles,
  DEFAULT_BASE_REF,
  hydrateQaContext,
  verifySurfaceMap,
} from '../../../.agents/scripts/lib/qa/qa-context-hydrator.js';

/**
 * Story #3805 — QA context hydrator (Epic #3798, f1-shared-qa-core).
 *
 * The hydrator assembles the Epic body (the single planning document since
 * Story #4324 folded the Tech Spec / Acceptance Table into managed body
 * sections) + project `.feature` files + the implementation surface map +
 * recent git log into one context object, and verifies every surface-map
 * path against the base ref (`main`) — marking absent paths as unverified
 * rather than trusting them. Every GitHub/git access flows through an
 * injected port so this whole suite runs with NO network and NO real repo.
 */

/**
 * An in-memory GitHub port: fetchIssue resolves from a fixture map and records
 * each fetched issue number so a test can assert the call shape.
 */
function fakeGithubPort(issues) {
  const fetched = [];
  return {
    fetched,
    async fetchIssue(number) {
      fetched.push(number);
      const issue = issues[number];
      if (!issue) throw new Error(`no fixture issue #${number}`);
      return { number, ...issue };
    },
  };
}

/**
 * An in-memory git port: `existsOnRef` returns true only for paths in
 * `trackedOnRef`, and `recentLog` returns a canned log slice respecting
 * `maxCount`.
 */
function fakeGitPort({ trackedOnRef = [], log = [] } = {}) {
  const calls = { existsOnRef: [], recentLog: [] };
  return {
    calls,
    existsOnRef(filePath, ref) {
      calls.existsOnRef.push({ filePath, ref });
      return trackedOnRef.includes(filePath);
    },
    recentLog({ maxCount }) {
      calls.recentLog.push({ maxCount });
      return log.slice(0, maxCount);
    },
  };
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-hydrator-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('collectFeatureFiles — .feature enumeration', () => {
  it('walks the feature root and returns sorted repo paths', () => {
    const root = path.join(tmpRoot, 'features');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'b.feature'), 'Feature: B');
    fs.writeFileSync(path.join(root, 'a.feature'), 'Feature: A');
    fs.writeFileSync(path.join(root, 'sub', 'c.feature'), 'Feature: C');
    fs.writeFileSync(path.join(root, 'ignore.md'), 'not a feature');

    const files = collectFeatureFiles(root);

    assert.equal(files.length, 3);
    assert.ok(files.every((f) => f.endsWith('.feature')));
    assert.ok(
      files.every((f) => !f.includes('\\')),
      'paths are POSIX-style',
    );
    // sorted, deterministic
    assert.deepEqual([...files].sort(), files);
  });

  it('returns an empty array for an absent feature root', () => {
    assert.deepEqual(collectFeatureFiles(undefined), []);
    assert.deepEqual(collectFeatureFiles(path.join(tmpRoot, 'nope')), []);
  });
});

describe('verifySurfaceMap — base-ref verification', () => {
  it('marks paths absent on the base ref as unverified', async () => {
    const gitPort = fakeGitPort({ trackedOnRef: ['src/real.js'] });
    const result = await verifySurfaceMap(
      [
        { path: 'src/real.js', note: 'from a comment' },
        { path: 'src/ghost.js' },
        'src/string-form.js',
      ],
      gitPort,
      'main',
    );

    assert.deepEqual(result, [
      { path: 'src/real.js', note: 'from a comment', verified: true },
      { path: 'src/ghost.js', note: null, verified: false },
      { path: 'src/string-form.js', note: null, verified: false },
    ]);
    // every entry was checked against the base ref, not trusted
    assert.equal(gitPort.calls.existsOnRef.length, 3);
    assert.ok(gitPort.calls.existsOnRef.every((c) => c.ref === 'main'));
  });

  it('tolerates a missing or non-array surface map', async () => {
    const gitPort = fakeGitPort();
    assert.deepEqual(await verifySurfaceMap(undefined, gitPort, 'main'), []);
    assert.deepEqual(await verifySurfaceMap(null, gitPort, 'main'), []);
  });
});

describe('hydrateQaContext — full assembly with injected ports (no network)', () => {
  function buildPorts() {
    // Story #4324: the Epic body is the single planning document. A
    // historical `## Planning Artifacts` checklist may still appear in a
    // body — it must be ignored (no context-ticket fetches).
    const githubPort = fakeGithubPort({
      3798: {
        body: [
          '## Context',
          'Epic context.',
          '',
          '## Planning Artifacts',
          '- PRD: #3800',
          '- Tech Spec: #3801',
          '- Acceptance Spec: #3802',
          '',
          '<!-- mandrel:tech-spec:start -->',
          '',
          '## Delivery Slicing',
          '| Slice | What ships | Independent? |',
          '',
          '<!-- mandrel:tech-spec:end -->',
        ].join('\n'),
        labels: ['type::story'],
      },
    });
    const gitPort = fakeGitPort({
      trackedOnRef: ['src/present.js'],
      log: [
        { sha: 'aaa', subject: 'feat: one' },
        { sha: 'bbb', subject: 'fix: two' },
      ],
    });
    return { githubPort, gitPort };
  }

  it('assembles epic, features, impl, and git log', async () => {
    const { githubPort, gitPort } = buildPorts();
    const featureRoot = path.join(tmpRoot, 'features');
    fs.mkdirSync(featureRoot, { recursive: true });
    fs.writeFileSync(path.join(featureRoot, 'x.feature'), 'Feature: X');

    const ctx = await hydrateQaContext({
      ticketNumber: 3798,
      githubPort,
      gitPort,
      featureRoot,
      surfaceMap: [
        { path: 'src/present.js' },
        { path: 'src/missing.js', note: 'trust me' },
      ],
    });

    // Only the Epic is fetched through the port — the folded body carries
    // the planning sections, and the legacy Planning Artifacts links are
    // ignored (no context-ticket fetches, Story #4324).
    assert.equal(ctx.epic.number, 3798);
    assert.match(ctx.epic.body, /## Delivery Slicing/);
    assert.deepEqual(githubPort.fetched, [3798]);
    assert.ok(
      !('contextTickets' in ctx),
      'the contextTickets result key is retired',
    );

    // Feature files discovered.
    assert.equal(ctx.featureFiles.length, 1);
    assert.ok(ctx.featureFiles[0].endsWith('x.feature'));

    // Surface map verified against the base ref; the absent path is unverified.
    assert.deepEqual(ctx.implementation, [
      { path: 'src/present.js', note: null, verified: true },
      { path: 'src/missing.js', note: 'trust me', verified: false },
    ]);
    assert.deepEqual(ctx.unverifiedPaths, ['src/missing.js']);
    assert.equal(ctx.baseRef, DEFAULT_BASE_REF);

    // Git log carried through, newest first.
    assert.deepEqual(ctx.gitLog, [
      { sha: 'aaa', subject: 'feat: one' },
      { sha: 'bbb', subject: 'fix: two' },
    ]);
  });

  it('returns empty feature/impl defaults when none are supplied', async () => {
    const githubPort = fakeGithubPort({
      42: { body: 'no planning links here', labels: ['type::story'] },
    });
    const gitPort = fakeGitPort();

    const ctx = await hydrateQaContext({
      ticketNumber: 42,
      githubPort,
      gitPort,
    });

    assert.deepEqual(ctx.featureFiles, []);
    assert.deepEqual(ctx.implementation, []);
    assert.deepEqual(githubPort.fetched, [42]);
  });

  it('honors a custom base ref and log max count', async () => {
    const { githubPort, gitPort } = buildPorts();

    await hydrateQaContext({
      ticketNumber: 3798,
      githubPort,
      gitPort,
      baseRef: 'develop',
      logMaxCount: 1,
      surfaceMap: [{ path: 'src/present.js' }],
    });

    assert.ok(gitPort.calls.existsOnRef.every((c) => c.ref === 'develop'));
    assert.deepEqual(gitPort.calls.recentLog, [{ maxCount: 1 }]);
  });

  it('rejects a missing epic number or unwired ports', async () => {
    const { githubPort, gitPort } = buildPorts();
    await assert.rejects(
      () => hydrateQaContext({ githubPort, gitPort }),
      /ticketNumber/,
    );
    await assert.rejects(
      () => hydrateQaContext({ ticketNumber: 1, gitPort }),
      /githubPort/,
    );
    await assert.rejects(
      () => hydrateQaContext({ ticketNumber: 1, githubPort }),
      /gitPort/,
    );
  });
});
