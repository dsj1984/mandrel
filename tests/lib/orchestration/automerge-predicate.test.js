import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveAutoMergeVerdict,
  evaluateAutoMergePredicate,
  parseAutomergeVerdictTrailer,
  parseSeverityCounts,
} from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js';
import { composeRetroBody } from '../../../.agents/scripts/lib/orchestration/retro/phases/compose-body.js';

// Build the compact retro body from the real composer so the predicate
// test exercises the actual machine-readable automerge-verdict trailer
// contract (Story #3901) rather than a hand-rolled fixture that can drift
// from the producer.
const COMPACT_COUNTS = {
  friction: 0,
  parked: 0,
  recuts: 0,
  hitl: 0,
  interventions: 0,
};

const cleanState = {
  epicId: 1178,
  manualInterventions: [],
  stories: {
    1191: { status: 'done' },
    1194: { status: 'done' },
    1198: { status: 'done' },
  },
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
  body: composeRetroBody({ epicId: 1178, counts: { ...COMPACT_COUNTS } }).body,
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

describe('parseAutomergeVerdictTrailer', () => {
  it('extracts cleanSprint + scorecard from a compact retro body', () => {
    const body = composeRetroBody({
      epicId: 7,
      counts: { ...COMPACT_COUNTS },
    }).body;
    const trailer = parseAutomergeVerdictTrailer(body);
    assert.equal(trailer.cleanSprint, true);
    assert.equal(trailer.scorecard.interventions, 0);
  });

  it('reports cleanSprint=false for a full retro body', () => {
    const body = composeRetroBody({
      epicId: 7,
      counts: { friction: 2, parked: 0, recuts: 0, hitl: 0, interventions: 0 },
    }).body;
    assert.equal(parseAutomergeVerdictTrailer(body).cleanSprint, false);
  });

  it('returns null when the trailer is absent', () => {
    assert.equal(parseAutomergeVerdictTrailer('## Retro\nNo trailer.'), null);
  });

  it('returns null on malformed trailer JSON', () => {
    assert.equal(
      parseAutomergeVerdictTrailer('<!-- automerge-verdict: {not json} -->'),
      null,
    );
  });

  it('returns null on non-string input', () => {
    assert.equal(parseAutomergeVerdictTrailer(null), null);
    assert.equal(parseAutomergeVerdictTrailer(undefined), null);
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

  it('returns clean=false when any Story is not done', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        ...cleanState,
        stories: {
          1191: { status: 'done' },
          1198: { status: 'blocked' },
        },
      },
      codeReview: cleanReview,
      retro: cleanRetro,
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('not done')));
  });

  it('returns clean=false when a story carries blockerCommentId', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        ...cleanState,
        stories: {
          1191: { status: 'done', blockerCommentId: 'comment-123' },
        },
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

  it('returns clean=false when the retro trailer reports cleanSprint=false', () => {
    // A full (non-compact) retro carries a trailer with cleanSprint=false.
    const fullRetroBody = composeRetroBody({
      epicId: 1178,
      counts: { friction: 3, parked: 1, recuts: 0, hitl: 0, interventions: 0 },
    }).body;
    const verdict = deriveAutoMergeVerdict({
      state: cleanState,
      codeReview: cleanReview,
      retro: { body: fullRetroBody },
    });
    assert.equal(verdict.clean, false);
    assert.ok(verdict.reasons.some((r) => r.includes('cleanSprint=false')));
  });

  it('returns clean=false when the retro trailer is missing entirely', () => {
    const verdict = deriveAutoMergeVerdict({
      state: cleanState,
      codeReview: cleanReview,
      retro: { body: '## Full retro\nFriction, parked, recuts.' },
    });
    assert.equal(verdict.clean, false);
    assert.ok(
      verdict.reasons.some((r) =>
        r.includes('missing the machine-readable automerge-verdict trailer'),
      ),
    );
  });

  it('does not false-positive on a body that merely quotes the legacy 🟢 Clean sprint prose', () => {
    // Pre-#3901 the predicate string-matched "🟢 Clean sprint"; a retro
    // body that quotes that phrase (e.g. in an action item) but carries
    // no trailer must NOT be certified clean.
    const verdict = deriveAutoMergeVerdict({
      state: cleanState,
      codeReview: cleanReview,
      retro: {
        body: '## Full retro\nAction: aim for a 🟢 Clean sprint next time.',
      },
    });
    assert.equal(verdict.clean, false);
    assert.equal(verdict.signals.retroCompact, false);
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
