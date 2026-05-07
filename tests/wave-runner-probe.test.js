/**
 * Integration probe: does this Claude Code release grant nested Agent
 * dispatch to a custom sub-agent type defined in .claude/agents/?
 *
 * Acceptance scope (Task #1133, Story #1122, Epic #1114):
 *
 * - The artefact under test is .claude/agents/wave-runner.md, whose
 *   frontmatter declares `tools: Agent, Read, Bash, Edit, Write, Glob, Grep,
 *   Skill`.
 *
 * - "B works" outcome — the harness allows a wave-runner sub-agent to call
 *   the Agent tool. Verifying this requires running inside Claude Code with
 *   the Agent tool present, dispatching a wave-runner sub-agent, and asking
 *   that child to dispatch a trivial general-purpose grandchild. Only the
 *   harness can exercise that path, so the assertion lives off the
 *   node-test path.
 *
 * - "B does not work" outcome — the harness forbids nested Agent dispatch
 *   regardless of the agent file's tools list. The Story sub-agent posts a
 *   friction comment naming the platform constraint, transitions Story
 *   #1122 to agent::blocked, and exits blocked.
 *
 * What this node-test asserts:
 *
 *   1. .claude/agents/wave-runner.md exists.
 *   2. Its YAML frontmatter contains the required `name`, `description`,
 *      and `tools` keys, and the `tools` value names every required tool
 *      (Agent, Read, Bash, Edit, Write, Glob, Grep, Skill).
 *   3. When the test runner has no harness Agent tool reachable
 *      (CLAUDE_AGENT_HARNESS env var unset), the live-dispatch step is
 *      explicitly skipped with a clear reason — never silently passed.
 *
 * The structural checks (1, 2) catch artefact regressions in CI.
 * Outcome (3) preserves the non-silent-skip property the Task AC demands.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AGENT_FILE = path.join(REPO_ROOT, '.claude', 'agents', 'wave-runner.md');

const REQUIRED_TOOLS = [
  'Agent',
  'Read',
  'Bash',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Skill',
];

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return null;
  }
  const block = match[1];
  const out = {};
  let lastKey = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const m = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (m) {
      lastKey = m[1];
      out[lastKey] = m[2].trim();
      continue;
    }
    // Continuation of a folded scalar (e.g. `description: >-` followed by
    // indented lines). Append the trimmed continuation to the prior key
    // so multi-line descriptions still parse.
    if (lastKey && /^\s+\S/.test(rawLine)) {
      const prior = out[lastKey] ?? '';
      out[lastKey] = `${prior} ${rawLine.trim()}`.trim();
    }
  }
  return out;
}

test('wave-runner.md exists at .claude/agents/', () => {
  assert.ok(fs.existsSync(AGENT_FILE), `expected ${AGENT_FILE} to exist`);
});

test('wave-runner.md frontmatter declares the required tools', () => {
  const text = fs.readFileSync(AGENT_FILE, 'utf8');
  const fm = parseFrontmatter(text);
  assert.ok(fm, 'expected YAML frontmatter delimited by --- lines');
  assert.equal(fm.name, 'wave-runner', 'frontmatter name must be wave-runner');
  assert.ok(
    typeof fm.description === 'string' && fm.description.length > 0,
    'frontmatter must include a non-empty description',
  );
  assert.ok(
    typeof fm.tools === 'string' && fm.tools.length > 0,
    'frontmatter must include a tools key',
  );
  const declared = fm.tools
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const tool of REQUIRED_TOOLS) {
    assert.ok(
      declared.includes(tool),
      `tools list must include "${tool}" (got: ${declared.join(', ')})`,
    );
  }
});

test('nested Agent dispatch — harness-coupled, skipped when unreachable', (t) => {
  if (!process.env.CLAUDE_AGENT_HARNESS) {
    t.skip(
      'CLAUDE_AGENT_HARNESS env var not set — this branch can only be ' +
        'exercised inside Claude Code with the Agent tool present. The ' +
        'live probe runs as a manual:harness-coupled step performed by ' +
        'the Story sub-agent itself, not by node --test.',
    );
    return;
  }
  // If a future harness wires up a CLI shim that proxies Agent calls, the
  // shim is expected to expose a binary at $CLAUDE_AGENT_HARNESS that
  // accepts a JSON request on stdin and prints a JSON response on stdout.
  // Until that shim exists, the assertion remains harness-coupled and
  // is performed live by the Story sub-agent during /story-execute.
  t.skip(
    'CLAUDE_AGENT_HARNESS shim is not implemented in this release. The ' +
      'live probe is performed by the Story sub-agent. See ' +
      '.claude/agents/wave-runner.md and the Story #1122 close comment ' +
      'for the live-probe outcome.',
  );
});
