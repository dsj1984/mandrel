import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  defaultProjectDir,
  mainCheckoutOf,
  runAgentCostReport,
} from '../../scripts/agent-cost-report.js';

const SENTINEL = 'SENTINEL-TOOL-RESULT-must-not-leak-5607';
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

function assistant(id, timestamp, effort = 'medium') {
  return {
    type: 'assistant',
    timestamp,
    effort,
    attributionSkill: 'mandrel-deliver',
    apiBlockIndex: 0,
    message: {
      id,
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', input: { command: SENTINEL } }],
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      },
    },
  };
}

function buildFixture() {
  const projects = tempDir('agent-cost-projects-');
  const lines = [
    { type: 'user', message: { content: SENTINEL } },
    assistant('m1', '2026-10-01T10:00:00.000Z'),
    {
      type: 'user',
      timestamp: '2026-10-01T10:00:10.000Z',
      toolUseResult: { stdout: SENTINEL },
    },
  ];
  fs.writeFileSync(
    path.join(projects, 'sess-1.jsonl'),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{broken\n`,
  );
  const subDir = path.join(projects, 'sess-1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    path.join(subDir, 'agent-w1.jsonl'),
    `${JSON.stringify(assistant('s1', '2026-09-01T10:00:00.000Z', 'high'))}\n`,
  );
  fs.writeFileSync(
    path.join(subDir, 'agent-w1.meta.json'),
    JSON.stringify({
      agentType: 'story-worker',
      description: 'Deliver Story 77',
    }),
  );
  return projects;
}

describe('agent-cost-report CLI', () => {
  it('writes report.json and summary.md with one row per session and subagent', () => {
    const projects = buildFixture();
    const outDir = tempDir('agent-cost-out-');
    const stdout = sink();

    const outcome = runAgentCostReport({
      argv: ['--project-dir', projects, '--out-dir', outDir],
      stdout,
      stderr: sink(),
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(stdout.text().trim(), outcome.summaryPath);
    const report = JSON.parse(fs.readFileSync(outcome.reportPath, 'utf8'));
    assert.equal(report.rows.length, 2);
    assert.equal(report.skippedLines, 1);
    const worker = report.rows.find((r) => r.agentType === 'story-worker');
    assert.equal(worker.storyId, 77);
    assert.deepEqual(worker.efforts, ['high']);
    assert.equal(worker.totalTokens, 10);
    for (const key of [
      'inputTokens',
      'cacheCreationTokens',
      'cacheReadTokens',
      'outputTokens',
      'thinkingTokens',
      'wallMs',
      'models',
    ]) {
      assert.ok(key in worker, `row carries ${key}`);
    }
    const summary = fs.readFileSync(outcome.summaryPath, 'utf8');
    assert.match(summary, /\| story-worker \| high \|/);
    assert.match(summary, /\| main \| medium \|/);
  });

  it('never writes message content, tool input or tool result', () => {
    const projects = buildFixture();
    const outDir = tempDir('agent-cost-out-');

    const outcome = runAgentCostReport({
      argv: ['--project-dir', projects, '--out-dir', outDir],
      stdout: sink(),
      stderr: sink(),
    });

    for (const file of [outcome.reportPath, outcome.summaryPath]) {
      assert.equal(fs.readFileSync(file, 'utf8').includes(SENTINEL), false);
    }
  });

  it('applies --since and --agent-type filters', () => {
    const projects = buildFixture();
    const outDir = tempDir('agent-cost-out-');

    const outcome = runAgentCostReport({
      argv: [
        '--project-dir',
        projects,
        '--out-dir',
        outDir,
        '--since',
        '2026-09-11',
        '--agent-type',
        'main',
      ],
      stdout: sink(),
      stderr: sink(),
    });

    const report = JSON.parse(fs.readFileSync(outcome.reportPath, 'utf8'));
    assert.deepEqual(
      report.rows.map((r) => r.agentType),
      ['main'],
    );
    assert.equal(report.filters.since, '2026-09-11');
  });

  it('exits 1 naming the project dir it tried when it is missing', () => {
    const base = tempDir('agent-cost-missing-');
    const missing = path.join(base, 'nope');
    const stderr = sink();

    const outcome = runAgentCostReport({
      argv: ['--project-dir', missing],
      stdout: sink(),
      stderr,
    });

    assert.equal(outcome.exitCode, 1);
    assert.match(stderr.text(), new RegExp(missing.replace(/\\/g, '\\\\')));
  });

  it('derives the default project dir from the main checkout slug', () => {
    const main = path.join('/Users', 'dev', 'mandrel');
    const worktree = path.join(main, '.worktrees', 'story-1');
    assert.equal(mainCheckoutOf(worktree), main);
    assert.equal(mainCheckoutOf(main), main);
    assert.equal(
      defaultProjectDir('/Users/dev/my.repo', '/home/u'),
      path.join('/home/u', '.claude', 'projects', '-Users-dev-my-repo'),
    );
  });
});
