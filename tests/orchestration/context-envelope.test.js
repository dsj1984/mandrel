import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildEnvelope,
  DEFAULT_ELIDE_POLICIES,
  DEFAULT_SECTION_PRIORITIES,
  elideEnvelope,
  envelopeToPrompt,
  estimateTokens,
  PROMPT_SECTION_SEPARATOR,
} from '../../.agents/scripts/lib/orchestration/context-envelope.js';

/** Build a section with defaults from the tech spec priority table. */
function section(name, content, overrides = {}) {
  return {
    name,
    priority: DEFAULT_SECTION_PRIORITIES[name],
    elideWhenOverBudget: DEFAULT_ELIDE_POLICIES[name],
    content,
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('uses Math.ceil(length / 4)', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
  });
});

describe('buildEnvelope', () => {
  it('returns required top-level fields', () => {
    const envelope = buildEnvelope({
      task: { id: 99, title: 'Fix bug', persona: 'engineer', skills: [] },
      sections: [section('taskInstructions', 'Do the thing')],
      provenance: [
        {
          id: 1,
          version: '2026-01-01T00:00:00.000Z',
          hash: 'abc123def456',
          retrievedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      warnings: ['version mismatch'],
      maxTokens: 500,
    });

    assert.equal(envelope.schemaVersion, '1');
    assert.equal(envelope.task.id, 99);
    assert.ok(Array.isArray(envelope.sections));
    assert.ok(Array.isArray(envelope.provenance));
    assert.deepEqual(envelope.budget, {
      maxTokens: 500,
      used: estimateTokens('Do the thing'),
      elided: [],
    });
    assert.deepEqual(envelope.warnings, ['version mismatch']);
  });

  it('stamps estimatedTokens on sections when omitted', () => {
    const envelope = buildEnvelope({
      task: { id: 1, title: 'T' },
      sections: [
        {
          name: 'persona',
          priority: 50,
          elideWhenOverBudget: 'summarize',
          content: 'hello',
        },
      ],
    });
    assert.equal(envelope.sections[0].estimatedTokens, estimateTokens('hello'));
  });
});

describe('elideEnvelope', () => {
  it('elides sections in ascending priority order and records elided names', () => {
    const long = 'x'.repeat(400);
    const envelope = buildEnvelope({
      task: { id: 1, title: 'T' },
      sections: [
        section('skillCapsules', long),
        section('verificationCommands', long),
        section('taskInstructions', 'must keep'),
      ],
      maxTokens: 10,
    });

    const elided = elideEnvelope(envelope, 10);

    assert.ok(elided.budget.elided.includes('skillCapsules'));
    assert.equal(
      elided.sections.find((s) => s.name === 'verificationCommands')?.content,
      '',
    );
    assert.ok(
      elided.budget.elided.indexOf('skillCapsules') <
        elided.budget.elided.indexOf('verificationCommands'),
    );
  });

  it('never drops or summarizes taskInstructions', () => {
    const huge = 'z'.repeat(2000);
    const envelope = buildEnvelope({
      task: { id: 1, title: 'T' },
      sections: [
        section('skillCapsules', 'a'.repeat(400)),
        section('hierarchy', 'b'.repeat(400)),
        section('protocolPolicy', 'c'.repeat(400)),
        section('taskInstructions', huge),
      ],
      maxTokens: 5,
    });

    const elided = elideEnvelope(envelope, 5);
    const taskSection = elided.sections.find(
      (s) => s.name === 'taskInstructions',
    );

    assert.equal(taskSection?.content, huge);
    assert.ok(!elided.budget.elided.includes('taskInstructions'));
    assert.ok(
      elided.warnings.some((w) => w.includes('Task instructions preserved')),
    );
  });

  it('summarizes sections with elideWhenOverBudget summarize', () => {
    const long = 'y'.repeat(500);
    const envelope = buildEnvelope({
      task: { id: 1, title: 'T' },
      sections: [
        section('skillCapsules', long),
        section('taskInstructions', 'keep'),
      ],
      maxTokens: 50,
    });

    const elided = elideEnvelope(envelope, 50);
    const skill = elided.sections.find((s) => s.name === 'skillCapsules');

    assert.match(skill?.content ?? '', /…\[elided, \d+ tokens dropped\]/);
    assert.ok(elided.budget.elided.includes('skillCapsules'));
  });
});

describe('envelopeToPrompt', () => {
  it('is deterministic — two calls yield byte-identical strings', () => {
    const envelope = buildEnvelope({
      task: { id: 42, title: 'Ship it' },
      sections: [
        section('protocolPolicy', 'Protocol body'),
        section('persona', 'Engineer persona'),
        section('taskInstructions', '## Task\n\nFix the bug'),
      ],
      warnings: ['⚠️ version drift'],
    });

    const first = envelopeToPrompt(envelope);
    const second = envelopeToPrompt(envelope);

    assert.equal(first, second);
    assert.ok(first.includes('Protocol body'));
    assert.ok(first.includes('Engineer persona'));
    assert.ok(first.includes('Fix the bug'));
    assert.ok(first.startsWith('⚠️ version drift'));
    assert.ok(first.includes(PROMPT_SECTION_SEPARATOR));
  });
});
