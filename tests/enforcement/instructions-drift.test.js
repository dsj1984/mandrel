import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTRUCTIONS_PATH = path.join(REPO_ROOT, '.agents', 'instructions.md');

const TASK_BRANCH_PATTERNS = [
  /task\/\[EPIC_ID\]/,
  /task\/\[TASK_ID\]/,
  /task\/<epicId>/,
];

const RETIRED_MCP_TOOLS = [
  'transition_ticket_state',
  'cascade_completion',
  'post_structured_comment',
];

function scanInstructions(content) {
  const taskBranchOffenses = [];
  const retiredMcpOffenses = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLegacyCallout = /legacy/i.test(line);
    if (!isLegacyCallout) {
      for (const pattern of TASK_BRANCH_PATTERNS) {
        if (pattern.test(line)) {
          taskBranchOffenses.push({
            line: i + 1,
            text: line.trim(),
            pattern: pattern.toString(),
          });
        }
      }
    }
    for (const tool of RETIRED_MCP_TOOLS) {
      if (line.includes(tool)) {
        retiredMcpOffenses.push({ line: i + 1, text: line.trim(), tool });
      }
    }
  }
  return { taskBranchOffenses, retiredMcpOffenses };
}

function formatOffenses(offenses) {
  return offenses
    .map((o) => `  L${o.line} [${o.pattern ?? o.tool}] ${o.text}`)
    .join('\n');
}

test('scanInstructions: flags task/[EPIC_ID] outside legacy callouts', () => {
  const sample = [
    '- **Format**: `task/[EPIC_ID]/[TASK_ID]`',
    'Legacy fallback: `task/[EPIC_ID]/[TASK_ID]` only.',
  ].join('\n');
  const { taskBranchOffenses } = scanInstructions(sample);
  assert.strictEqual(taskBranchOffenses.length, 1);
  assert.strictEqual(taskBranchOffenses[0].line, 1);
});

test('scanInstructions: flags retired MCP tool names', () => {
  const sample = [
    'Use transition_ticket_state for atomic transitions.',
    'Call cascade_completion after marking done.',
    'post_structured_comment is the canonical channel.',
  ].join('\n');
  const { retiredMcpOffenses } = scanInstructions(sample);
  assert.deepStrictEqual(
    retiredMcpOffenses.map((o) => o.tool),
    [
      'transition_ticket_state',
      'cascade_completion',
      'post_structured_comment',
    ],
  );
});

test('scanInstructions: ignores hyphenated CLI script names', () => {
  const sample = '`node .agents/scripts/post-structured-comment.js --ticket 1`';
  const { retiredMcpOffenses } = scanInstructions(sample);
  assert.strictEqual(retiredMcpOffenses.length, 0);
});

test('instructions.md has no retired task branch syntax outside legacy callouts', () => {
  const content = fs.readFileSync(INSTRUCTIONS_PATH, 'utf8');
  const { taskBranchOffenses } = scanInstructions(content);
  assert.deepStrictEqual(
    taskBranchOffenses,
    [],
    `instructions.md contains task/[EPIC_ID]-style references outside a legacy callout:\n${formatOffenses(taskBranchOffenses)}`,
  );
});

test('instructions.md has no retired mandrel MCP tool names', () => {
  const content = fs.readFileSync(INSTRUCTIONS_PATH, 'utf8');
  const { retiredMcpOffenses } = scanInstructions(content);
  assert.deepStrictEqual(
    retiredMcpOffenses,
    [],
    `instructions.md references retired MCP tools (use the in-repo CLI scripts under .agents/scripts/ instead):\n${formatOffenses(retiredMcpOffenses)}`,
  );
});

export { scanInstructions };
