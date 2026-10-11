import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { readProjectDir } from '../../../scripts/lib/agent-cost/read-transcripts.js';

const SENTINEL = 'SENTINEL-CONTENT-must-not-leak-5607';
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function projectDir() {
  const dir = makeTempDir('agent-cost-read-');
  dirs.push(dir);
  return dir;
}

/** One assistant content-block record; usage repeats per block. */
function block(id, apiBlockIndex, opts = {}) {
  return {
    type: 'assistant',
    timestamp: opts.timestamp ?? '2026-10-01T10:00:00.000Z',
    effort: opts.effort ?? 'medium',
    attributionSkill: opts.skill ?? 'mandrel-deliver',
    apiBlockIndex,
    message: {
      id,
      model: opts.model ?? 'claude-opus-5-5',
      content: [{ type: 'text', text: SENTINEL }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: opts.cacheCreation ?? 100,
        cache_read_input_tokens: 1000,
        output_tokens: opts.output ?? 5,
        output_tokens_details: { thinking_tokens: 2 },
      },
    },
  };
}

function writeJsonl(file, records, extraLines = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).concat(extraLines);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

describe('readProjectDir', () => {
  it('counts a message split across three block records once', () => {
    const dir = projectDir();
    writeJsonl(path.join(dir, 'sess-1.jsonl'), [
      { type: 'user', timestamp: '2026-10-01T09:59:00.000Z' },
      block('msg_a', 0),
      block('msg_a', 1),
      block('msg_a', 2, { output: 50, timestamp: '2026-10-01T10:00:30.000Z' }),
    ]);

    const { rows } = readProjectDir(dir);

    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.messages, 1);
    // The naive per-record sum would be 3× the input and cache figures.
    assert.equal(row.inputTokens, 10);
    assert.equal(row.cacheCreationTokens, 100);
    assert.equal(row.cacheReadTokens, 1000);
    // The highest apiBlockIndex record wins.
    assert.equal(row.outputTokens, 50);
    assert.equal(row.thinkingTokens, 2);
    assert.equal(row.totalTokens, 10 + 100 + 1000 + 50);
    assert.notEqual(row.totalTokens, 3 * (10 + 100 + 1000) + 5 + 5 + 50);
    assert.equal(row.agentType, 'main');
    assert.equal(row.agentId, null);
    assert.equal(row.startedAt, '2026-10-01T09:59:00.000Z');
    assert.equal(row.wallMs, 90_000);
  });

  it('reads subagent transcripts with their meta.json identity', () => {
    const dir = projectDir();
    writeJsonl(path.join(dir, 'sess-1.jsonl'), [block('msg_main', 0)]);
    const subDir = path.join(dir, 'sess-1', 'subagents');
    writeJsonl(path.join(subDir, 'agent-abc.jsonl'), [
      block('msg_sub', 0, { effort: 'high', model: 'claude-fable-5' }),
    ]);
    fs.writeFileSync(
      path.join(subDir, 'agent-abc.meta.json'),
      JSON.stringify({
        agentType: 'story-worker',
        description: 'Deliver Story #5332',
        spawnDepth: 1,
      }),
    );

    const { rows } = readProjectDir(dir);
    const sub = rows.find((r) => r.agentId === 'abc');

    assert.equal(rows.length, 2);
    assert.equal(sub.sessionId, 'sess-1');
    assert.equal(sub.agentType, 'story-worker');
    assert.equal(sub.storyId, 5332);
    assert.deepEqual(sub.efforts, ['high']);
    assert.deepEqual(sub.models, ['claude-fable-5']);
    assert.equal(sub.skill, 'mandrel-deliver');
  });

  it('measures effort changes and the cache rebuilt after the first one', () => {
    const dir = projectDir();
    writeJsonl(path.join(dir, 'sess-2.jsonl'), [
      block('m1', 0, { effort: 'medium', cacheCreation: 5000 }),
      block('m2', 0, { effort: 'medium', cacheCreation: 10 }),
      block('m3', 0, { effort: 'high', cacheCreation: 4000 }),
      block('m4', 0, { effort: 'high', cacheCreation: 20 }),
      block('m5', 0, { effort: 'medium', cacheCreation: 30 }),
    ]);

    const [row] = readProjectDir(dir).rows;

    assert.equal(row.effortChanges, 2);
    assert.equal(row.cacheCreationAfterFirstEffortChange, 4000 + 20 + 30);
    assert.deepEqual(row.efforts, ['medium', 'high']);
    assert.equal(row.primaryEffort, 'medium');
  });

  it('skips and counts unparseable lines without failing', () => {
    const dir = projectDir();
    writeJsonl(
      path.join(dir, 'sess-3.jsonl'),
      [block('m1', 0)],
      ['{not json', '42'],
    );

    const { rows, skippedLines } = readProjectDir(dir);

    assert.equal(rows.length, 1);
    assert.equal(skippedLines, 2);
  });

  it('copies no message content into a row', () => {
    const dir = projectDir();
    writeJsonl(path.join(dir, 'sess-4.jsonl'), [block('m1', 0)]);

    const { rows } = readProjectDir(dir);

    assert.equal(JSON.stringify(rows).includes(SENTINEL), false);
  });

  it('skips files last modified before sinceMs', () => {
    const dir = projectDir();
    const file = path.join(dir, 'old.jsonl');
    writeJsonl(file, [block('m1', 0)]);
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);

    const { rows } = readProjectDir(dir, {
      sinceMs: Date.parse('2026-01-01T00:00:00Z'),
    });

    assert.equal(rows.length, 0);
  });
});
