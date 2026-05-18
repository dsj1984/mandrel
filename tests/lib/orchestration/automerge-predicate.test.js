import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CLEAN_SPRINT_MARKER,
  deriveAutoMergeVerdict,
  evaluateAutoMergePredicate,
  parseSeverityCounts,
} from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js';

const cleanState = {
  epicId: 1178,
  manualInterventions: [],
  waves: [
    {
      wave: 0,
      status: 'complete',
      stories: [
        { id: 1191, status: 'done', blockerCommentId: null },
        { id: 1194, status: 'done', blockerCommentId: null },
      ],
    },
    {
      wave: 1,
      status: 'complete',
      stories: [{ id: 1198, status: 'done', blockerCommentId: null }],
    },
  ],
};

const cleanReview = {
  body: [
    '## 🔬 Automated Code Review',
    '- 🔴 Critical Blocker: 0',
    '- 🟠 High Risk: 0',
    '- 🟡 Medium Risk: 1',
    '- 🟢 Suggestion: 0',
  ].join('\n'),
};

const cleanRetro = {
  body: [
    '## Sprint Retro',
    '',
    `${CLEAN_SPRINT_MARKER} — zero friction, zero parked follow-ons, zero recuts, zero hotfixes, zero agent::blocked events.`,
    '',
    '### Sprint Scorecard',
  ].join('\n'),
};

describe('parseSeverityCounts', () => {
  it('extracts all four tiers from rendered markdown bullets', () => {
    const body = [
      '- 🔴 Critical Blocker: 0',
      '- 🟠 High Risk: 2',
      '- 🟡 Medium Risk: 5',
      '- 🟢 Suggestion: 12',
    ].join('\n');
    assert.deepEqual(parseSeverityCounts(body), {
      critical: 0,
      high: 2,
      medium: 5,
      suggestion: 12,
    });
  });

  it('returns null fields when bullets are missing', () => {
    const body = '## Just a heading\nNo bullets here.';
    const out = parseSeverityCounts(body);
    assert.equal(out.critical, null);
    assert.equal(out.high, null);
  });

  it('handles empty / non-string input safely', () => {
    assert.deepEqual(parseSeverityCounts(''), {
      critical: null,
      high: null,
      medium: null,
      suggestion: null,
    });
    assert.deepEqual(parseSeverityCounts(null), {
      critical: null,
      high: null,
      medium: null,
      suggestion: null,
    });
  });
});

describe('deriveAutoMergeVerdict', () => {
  it('returns clean=true when every signal is healthy', () => {
    const verdict = deriveAutoMergeVerdict({
      state: cleanState,
      codeReview: cleanReview,
      retro: cleanRetro,
    });
    assert.equal(verdict.clean, true);
    assert.deepEqual(verdict.reasons, []);
    assert.equal(verdict.signals.manualInterventions, 0);
    assert.equal(verdict.signals.retroCompact, true);
    assert.equal(verdict.signals.severity.critical, 0);
    assert.equal(verdict.signals.severity.high, 0);
  });

  it('returns clean=false when manualInterventions is non-empty', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        ...cleanState,
        manualInterventions: [
          { reason: 'discarded drift', source: 'host-llm', ts: '2026-05-11' },
        ],
      },
      codeReview: cleanReview,
      retro: cleanRetro,
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('manual intervention')));
  });

  it('returns clean=false when any wave is not complete', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        ...cleanState,
        waves: [
          { wave: 0, status: 'complete', stories: [] },
          { wave: 1, status: 'blocked', stories: [] },
        ],
      },
      codeReview: cleanReview,
      retro: cleanRetro,
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('not complete')));
  });

  it('returns clean=false when a story carries blockerCommentId', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        ...cleanState,
        waves: [
          {
            wave: 0,
            status: 'complete',
            stories: [
              {
                id: 1191,
                status: 'done',
                blockerCommentId: 'comment-123',
              },
            ],
          },
        ],
      },
      codeReview: cleanReview,
      retro: cleanRetro,
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('story-level blocker')));
  });

  it('returns clean=false when code-review reports a 🔴 Critical', () => {
    const review = {
      body: ['- 🔴 Critical Blocker: 1', '- 🟠 High Risk: 0'].join('\n'),
    };
    const verdict = deriveAutoMergeVerdict({
      state: cleanState,
      codeReview: review,
      retro: cleanRetro,
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('Critical Blocker')));
  });

  it('returns clean=false when code-review reports a 🟠 High Risk', () => {
    const review = {
      body: ['- 🔴 Critical Blocker: 0', '- 🟠 High Risk: 3'].join('\n'),
    };
    const verdict = deriveAutoMergeVerdict({
      state: cleanState,
      codeReview: review,
      retro: cleanRetro,
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('High Risk')));
  });

  it('returns clean=false when retro is not compact', () => {
    const verdict = deriveAutoMergeVerdict({
      state: cleanState,
      codeReview: cleanReview,
      retro: { body: '## Full retro\nFriction, parked, recuts.' },
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('not compact')));
  });

  it('returns clean=false when state / code-review / retro are missing', () => {
    const verdict = deriveAutoMergeVerdict({
      state: null,
      codeReview: null,
      retro: null,
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('checkpoint missing')));
    assert.ok(
      verdict.reasons.some((r) =>
        r.includes('code-review structured comment not found'),
      ),
    );
    assert.ok(
      verdict.reasons.some((r) =>
        r.includes('retro structured comment not found'),
      ),
    );
  });
});

describe('evaluateAutoMergePredicate', () => {
  it('wires checkpoint + code-review + retro into deriveAutoMergeVerdict', async () => {
    const fakeProvider = { __tag: 'provider' };
    const captured = { findCalls: [] };
    const findCommentFn = async (provider, ticketId, type) => {
      assert.equal(provider, fakeProvider);
      captured.findCalls.push({ ticketId, type });
      if (type === 'code-review') return cleanReview;
      if (type === 'retro') return cleanRetro;
      if (type === 'retro-partial') return null;
      return null;
    };
    const readRunStateFn = async ({ provider, epicId }) => {
      assert.equal(provider, fakeProvider);
      assert.equal(epicId, 1178);
      return cleanState;
    };
    const out = await evaluateAutoMergePredicate({
      provider: fakeProvider,
      epicId: 1178,
      findCommentFn,
      readRunStateFn,
    });
    assert.equal(out.clean, true);
    assert.deepEqual(out.reasons, []);
    const types = captured.findCalls.map((c) => c.type).sort();
    assert.deepEqual(types, ['code-review', 'retro']);
  });

  it('falls back to retro-partial when retro is absent', async () => {
    const fakeProvider = {};
    const findCommentFn = async (_p, _id, type) => {
      if (type === 'code-review') return cleanReview;
      if (type === 'retro') return null;
      if (type === 'retro-partial') return cleanRetro;
      return null;
    };
    const readRunStateFn = async () => cleanState;
    const out = await evaluateAutoMergePredicate({
      provider: fakeProvider,
      epicId: 1178,
      findCommentFn,
      readRunStateFn,
    });
    assert.equal(out.clean, true);
  });

  it('rejects invalid arguments', async () => {
    await assert.rejects(
      () =>
        evaluateAutoMergePredicate({
          provider: null,
          epicId: 1,
          readRunStateFn: async () => null,
        }),
      /provider required/,
    );
    await assert.rejects(
      () =>
        evaluateAutoMergePredicate({
          provider: {},
          epicId: 0,
          readRunStateFn: async () => null,
        }),
      /positive integer/,
    );
  });
});
