/**
 * tests/planning-corpus.test.js — Story #4432.
 *
 * Covers the corpus-aware context assembly for the standalone-Story
 * planning path:
 *   - rankCandidateEpics: title-overlap ranking + top-K cap, reusing
 *     duplicate-search.js's tokenize/overlapScore.
 *   - fetchCandidateBodies: the explicit, bounded per-candidate body
 *     fetch — proven against a fake provider whose list surface omits
 *     `body` (mirroring `issueToEpicListItem`).
 *   - extractRelevantSections: Tech Spec / lede excerpt scoring, reusing
 *     the same tokenize/overlapScore primitives.
 *   - buildCorpusContext: end-to-end orchestration, including the
 *     null-docsDigest / empty-corpus degrade path.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as duplicateSearch from '../.agents/scripts/lib/duplicate-search.js';
import { upsertEpicSection } from '../.agents/scripts/lib/epic-body-sections.js';
import {
  buildCorpusContext,
  DEFAULT_CORPUS_BODY_FETCH_TOP_K,
  extractRelevantSections,
  fetchCandidateBodies,
  rankCandidateEpics,
} from '../.agents/scripts/lib/planning-corpus.js';

describe('rankCandidateEpics', () => {
  it('ranks higher title-overlap Epics first', () => {
    const ranked = rankCandidateEpics({
      seed: 'route small change requests to the standalone Story path',
      epics: [
        { id: 1, title: 'unrelated database migration cleanup' },
        { id: 2, title: 'route change requests to standalone Story path' },
      ],
    });
    assert.ok(ranked.length >= 2);
    assert.equal(ranked[0].id, 2);
    assert.ok(ranked[0].score >= ranked[1].score);
  });

  it('caps the result list at maxResults', () => {
    const epics = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      title: `standalone story corpus context helper ${i}`,
    }));
    const ranked = rankCandidateEpics({
      seed: 'standalone story corpus context helper',
      epics,
      maxResults: 3,
    });
    assert.equal(ranked.length, 3);
  });

  it('returns [] when the seed tokenizes to nothing', () => {
    const ranked = rankCandidateEpics({
      seed: 'a an the',
      epics: [{ id: 1, title: 'anything' }],
    });
    assert.deepEqual(ranked, []);
  });

  it('throws on a missing seed', () => {
    assert.throws(
      () => rankCandidateEpics({ seed: '', epics: [] }),
      /seed must be a non-empty string/,
    );
  });

  it('throws when epics is not an array', () => {
    assert.throws(
      () => rankCandidateEpics({ seed: 'x', epics: null }),
      /epics must be an array/,
    );
  });

  it('reuses duplicate-search.js tokenize/overlapScore (no forked matcher)', () => {
    const seed = 'shared scoring primitive check';
    const epics = [{ id: 1, title: 'shared scoring primitive reused here' }];
    const ranked = rankCandidateEpics({ seed, epics });
    const expected = duplicateSearch.overlapScore(
      duplicateSearch.tokenize(seed),
      duplicateSearch.tokenize(epics[0].title),
    );
    assert.equal(ranked[0].score, Number(expected.toFixed(4)));
  });
});

describe('fetchCandidateBodies', () => {
  it('fetches bodies explicitly via provider.getEpic — the list surface never carries body', () => {
    const candidates = [
      { id: 1, title: 'Epic one' },
      { id: 2, title: 'Epic two' },
    ];
    // The list mapper (issueToEpicListItem) never includes `body`; the
    // candidate objects here mirror that omission. getEpic is the only
    // surface that resolves body content.
    const calls = [];
    const provider = {
      async getEpic(id) {
        calls.push(id);
        return { id, title: `Epic ${id}`, body: `body for ${id}` };
      },
    };
    return fetchCandidateBodies({ provider, candidates }).then((bodies) => {
      assert.deepEqual(calls, [1, 2]);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].body, 'body for 1');
      assert.equal(bodies[1].body, 'body for 2');
    });
  });

  it('bounds the fetch to topK candidates', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      title: `Epic ${i}`,
    }));
    const calls = [];
    const provider = {
      async getEpic(id) {
        calls.push(id);
        return { id, title: `Epic ${id}`, body: 'body' };
      },
    };
    const bodies = await fetchCandidateBodies({
      provider,
      candidates,
      topK: 3,
    });
    assert.equal(calls.length, 3);
    assert.equal(bodies.length, 3);
  });

  it('defaults topK to DEFAULT_CORPUS_BODY_FETCH_TOP_K', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      title: `Epic ${i}`,
    }));
    const provider = {
      async getEpic(id) {
        return { id, title: `Epic ${id}`, body: 'body' };
      },
    };
    const bodies = await fetchCandidateBodies({ provider, candidates });
    assert.equal(bodies.length, DEFAULT_CORPUS_BODY_FETCH_TOP_K);
  });

  it('drops a candidate whose fetch fails without aborting the rest', async () => {
    const candidates = [
      { id: 1, title: 'ok' },
      { id: 2, title: 'fails' },
      { id: 3, title: 'ok too' },
    ];
    const provider = {
      async getEpic(id) {
        if (id === 2) throw new Error('boom');
        return { id, title: `Epic ${id}`, body: 'body' };
      },
    };
    const bodies = await fetchCandidateBodies({ provider, candidates });
    assert.deepEqual(
      bodies.map((b) => b.id),
      [1, 3],
    );
  });

  it('returns [] when the provider has no getEpic surface', async () => {
    const bodies = await fetchCandidateBodies({
      provider: {},
      candidates: [{ id: 1, title: 'x' }],
    });
    assert.deepEqual(bodies, []);
  });

  it('returns [] for an empty candidate list', async () => {
    const bodies = await fetchCandidateBodies({
      provider: { getEpic: async () => ({}) },
      candidates: [],
    });
    assert.deepEqual(bodies, []);
  });
});

describe('extractRelevantSections', () => {
  it('extracts and scores the managed Tech Spec region when present', () => {
    const body = upsertEpicSection(
      '# Some Epic\n\n## Goal\n\nUnrelated preamble.\n',
      'techSpec',
      '## Delivery Slicing\n\nStandalone-Story corpus context assembly and rubric work.\n',
    );
    const sections = extractRelevantSections({
      seed: 'standalone story corpus context assembly',
      epicBodies: [{ id: 7, title: 'Prior corpus Epic', body }],
    });
    assert.equal(sections.length, 1);
    assert.equal(sections[0].epicId, 7);
    assert.equal(sections[0].section, 'techSpec');
    assert.match(sections[0].excerpt, /Delivery Slicing/);
  });

  it('falls back to the ideation lede when no Tech Spec region exists', () => {
    const body =
      '# Plain Epic\n\nRoute change requests to the standalone path.\n\n## Goal\n\nOther content.\n';
    const sections = extractRelevantSections({
      seed: 'route change requests to the standalone path',
      epicBodies: [{ id: 9, title: 'Plain Epic', body }],
    });
    assert.equal(sections.length, 1);
    assert.equal(sections[0].section, 'lede');
  });

  it('drops candidates below minScore', () => {
    const body = '# Epic\n\nCompletely unrelated content about widgets.\n';
    const sections = extractRelevantSections({
      seed: 'standalone story corpus rubric assembly',
      epicBodies: [{ id: 1, title: 'Widgets Epic', body }],
      minScore: 0.5,
    });
    assert.deepEqual(sections, []);
  });

  it('caps the excerpt length', () => {
    const longContent = 'corpus '.repeat(500);
    const body = `# Epic\n\n${longContent}`;
    const sections = extractRelevantSections({
      seed: 'corpus',
      epicBodies: [{ id: 1, title: 'Big Epic', body }],
      minScore: 0,
    });
    assert.ok(sections[0].excerpt.length <= 600);
  });

  it('throws on a missing seed', () => {
    assert.throws(
      () => extractRelevantSections({ seed: '', epicBodies: [] }),
      /seed must be a non-empty string/,
    );
  });
});

describe('buildCorpusContext', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'planning-corpus-'));
    mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns docsDigest: null when no docsContextFiles are configured', async () => {
    const ctx = await buildCorpusContext({
      seed: 'anything',
      provider: undefined,
      docsContextFiles: [],
      docsRoot: path.join(tmp, 'docs'),
    });
    assert.equal(ctx.docsDigest, null);
    assert.deepEqual(ctx.relevantSections, []);
  });

  it('builds a non-null docsDigest when docsContextFiles resolve', async () => {
    writeFileSync(
      path.join(tmp, 'docs', 'architecture.md'),
      '# Architecture\n\n## Overview\n\nSome architecture notes.\n',
    );
    const ctx = await buildCorpusContext({
      seed: 'anything',
      provider: undefined,
      docsContextFiles: ['architecture.md'],
      docsRoot: path.join(tmp, 'docs'),
    });
    assert.equal(typeof ctx.docsDigest, 'string');
    assert.match(ctx.docsDigest, /architecture\.md/);
  });

  it('returns [] relevantSections when the provider has no getEpics surface', async () => {
    const ctx = await buildCorpusContext({
      seed: 'anything',
      provider: {},
      docsContextFiles: [],
      docsRoot: path.join(tmp, 'docs'),
    });
    assert.deepEqual(ctx.relevantSections, []);
  });

  it('fetches candidate bodies explicitly and ranks relevant sections end-to-end, against a fake provider whose list surface returns no bodies', async () => {
    const techSpecBody = upsertEpicSection(
      '# Change-request triage Epic\n\n## Goal\n\nRoute deltas.\n',
      'techSpec',
      '## Delivery Slicing\n\nCorpus-aware standalone-Story planning path rubric assembly.\n',
    );
    const otherBody = '# Unrelated Epic\n\nSomething about widgets.\n';

    const getEpicCalls = [];
    const provider = {
      // Mirrors issueToEpicListItem: the list surface never carries body.
      async getEpics() {
        return [
          { id: 101, title: 'Corpus-aware standalone-Story planning path' },
          { id: 202, title: 'Widgets and unrelated things' },
        ];
      },
      async getEpic(id) {
        getEpicCalls.push(id);
        if (id === 101) {
          return {
            id,
            title: 'Corpus-aware standalone-Story planning path',
            body: techSpecBody,
          };
        }
        return { id, title: 'Widgets and unrelated things', body: otherBody };
      },
    };

    const ctx = await buildCorpusContext({
      seed: 'corpus-aware standalone-story planning path rubric assembly',
      provider,
      docsContextFiles: [],
      docsRoot: path.join(tmp, 'docs'),
    });

    // Proves the body fetch happened explicitly (not assumed from the
    // bodyless list surface).
    assert.ok(getEpicCalls.includes(101));
    assert.ok(ctx.relevantSections.length >= 1);
    const top = ctx.relevantSections[0];
    assert.equal(top.epicId, 101);
    assert.equal(top.section, 'techSpec');
  });
});
