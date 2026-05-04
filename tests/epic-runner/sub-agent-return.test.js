import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseStoryAgentReturn,
  reconcileStoryFromGitHub,
  renderMalformedReturnsFriction,
} from '../../.agents/scripts/lib/orchestration/epic-runner/sub-agent-return.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

test('parseStoryAgentReturn — accepts canonical envelope object', () => {
  const out = parseStoryAgentReturn({
    storyId: 612,
    status: 'done',
    phase: 'done',
    tasksDone: 2,
    tasksTotal: 2,
    branchDeleted: true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.storyId, 612);
  assert.equal(out.value.status, 'done');
  assert.equal(out.value.tasksDone, 2);
  assert.equal(out.value.branchDeleted, true);
});

test('parseStoryAgentReturn — accepts JSON string', () => {
  const text = JSON.stringify({ storyId: 7, status: 'blocked' });
  const out = parseStoryAgentReturn(text);
  assert.equal(out.ok, true);
  assert.equal(out.value.storyId, 7);
  assert.equal(out.value.status, 'blocked');
});

test('parseStoryAgentReturn — accepts fenced ```json``` block with prelude', () => {
  const text = [
    'Some narration about the wave.',
    '```json',
    JSON.stringify({ storyId: 12, status: 'done' }),
    '```',
    'And more narration after.',
  ].join('\n');
  const out = parseStoryAgentReturn(text);
  assert.equal(out.ok, true);
  assert.equal(out.value.storyId, 12);
});

test('parseStoryAgentReturn — accepts inline {…} substring with chat prelude', () => {
  const text = `OK done. ${JSON.stringify({ storyId: 99, status: 'failed', detail: 'boom' })}`;
  const out = parseStoryAgentReturn(text);
  assert.equal(out.ok, true);
  assert.equal(out.value.storyId, 99);
  assert.equal(out.value.detail, 'boom');
});

test('parseStoryAgentReturn — rejects free-text fragment (Epic #604 reproducer)', () => {
  // The exact return text the general-purpose sub-agent emitted on
  // 2026-05-04 mid-Task-#624. Without this guard the wave-runner used to
  // propagate the fragment into the wave-record results array.
  const out = parseStoryAgentReturn('Clean. Now commit Task 622.');
  assert.equal(out.ok, false);
  assert.match(out.error, /no parseable JSON envelope/);
});

test('parseStoryAgentReturn — rejects empty / non-string / null', () => {
  assert.equal(parseStoryAgentReturn('').ok, false);
  assert.equal(parseStoryAgentReturn('   ').ok, false);
  assert.equal(parseStoryAgentReturn(null).ok, false);
  assert.equal(parseStoryAgentReturn(42).ok, false);
});

test('parseStoryAgentReturn — rejects valid JSON with missing storyId', () => {
  const out = parseStoryAgentReturn(JSON.stringify({ status: 'done' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /storyId must be a positive integer/);
});

test('parseStoryAgentReturn — rejects valid JSON with bad status', () => {
  const out = parseStoryAgentReturn(
    JSON.stringify({ storyId: 1, status: 'partial' }),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /must be one of: done, blocked, failed/);
});

test('reconcileStoryFromGitHub — agent::executing label downgrades to failed', async () => {
  const provider = {
    async getTicket(id) {
      assert.equal(id, 612);
      return {
        id: 612,
        labels: ['type::story', 'agent::executing'],
        state: 'open',
      };
    },
    async getTicketComments() {
      return [];
    },
  };
  const out = await reconcileStoryFromGitHub({ provider, storyId: 612 });
  assert.equal(out.storyId, 612);
  assert.equal(out.status, 'failed');
  assert.equal(out.reconciledFromGitHub, true);
});

test('reconcileStoryFromGitHub — agent::done label preserves done', async () => {
  const provider = {
    async getTicket(id) {
      return { id, labels: ['agent::done'], state: 'closed' };
    },
    async getTicketComments() {
      return [];
    },
  };
  const out = await reconcileStoryFromGitHub({ provider, storyId: 700 });
  assert.equal(out.status, 'done');
});

test('reconcileStoryFromGitHub — story-run-progress fills phase + counters', async () => {
  const marker = structuredCommentMarker('story-run-progress');
  const payload = {
    kind: 'story-run-progress',
    storyId: 612,
    phase: 'closing',
    tasks: [
      { id: 622, state: 'done' },
      { id: 624, state: 'executing' },
    ],
    updatedAt: '2026-05-04T00:00:00Z',
  };
  const provider = {
    async getTicket(id) {
      return { id, labels: ['agent::executing'], state: 'open' };
    },
    async getTicketComments() {
      return [
        {
          id: 1,
          ticketId: 612,
          body: `${marker}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
        },
      ];
    },
  };
  const out = await reconcileStoryFromGitHub({ provider, storyId: 612 });
  assert.equal(out.status, 'failed');
  assert.equal(out.phase, 'closing');
  assert.equal(out.tasksDone, 1);
  assert.equal(out.tasksTotal, 2);
});

test('reconcileStoryFromGitHub — getTicket throw is non-fatal, returns failed + reconcileError', async () => {
  const provider = {
    async getTicket() {
      throw new Error('GraphQL 502');
    },
    async getTicketComments() {
      return [];
    },
  };
  const out = await reconcileStoryFromGitHub({ provider, storyId: 5 });
  assert.equal(out.status, 'failed');
  assert.match(out.reconcileError, /GraphQL 502/);
});

test('renderMalformedReturnsFriction — body lists every failure with quoted text', () => {
  const body = renderMalformedReturnsFriction({
    epicId: 604,
    wave: 0,
    failures: [
      {
        storyId: 612,
        error: 'no parseable JSON envelope',
        returnText: 'Clean. Now commit Task 622.',
      },
    ],
  });
  assert.match(body, /Epic #604, wave 0/);
  assert.match(body, /Story #612/);
  assert.match(body, /Clean\. Now commit Task 622\./);
});
