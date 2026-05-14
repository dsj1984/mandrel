/**
 * subagent-agent-tool-required — refuse-and-print check.
 *
 * Detects sub-agent workflow definitions that declare access to the
 * `Agent` tool (or otherwise document nested Agent dispatch). Nested
 * Agent dispatch is not supported in this Claude Code, so any
 * wave-runner-as-sub-agent or cascading fan-out design that declares
 * `Agent` in its tool list will silently fail at runtime. The remediation
 * is to flatten the fan-out back to the host agent and run sub-agents at
 * one level only.
 *
 * Scope: 'epic-deliver', 'retro'. Surfaces as a blocker at preflight for
 * `epic-deliver` (the fan-out site) and as audit signal at retro.
 *
 * The check is `refuse-and-print` — auto-rewriting a workflow's tool
 * list would silently change runtime behavior in ways the operator may
 * not have intended (the workflow's logic may depend on the missing
 * tool). The fixCommand cites the flatten-fan-out remediation pattern.
 *
 * Implementation note: we scan `.agents/workflows/*.md` for workflow
 * files whose frontmatter or body identifies them as a sub-agent role
 * AND whose `tools:` declaration includes `Agent`. The marker for
 * "sub-agent" is the phrase `sub-agent` appearing in the description /
 * overview region. This keeps the check stable while the workflow
 * surface evolves — the project doesn't yet have a structured
 * `role: sub-agent` frontmatter field, and the textual marker is what
 * the human contributors actually grep for.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR_DEFAULT = path.join('.agents', 'workflows');

/**
 * Walk a workflow directory and return absolute `.md` file paths
 * (non-recursive — the workflows surface is one level deep; helpers/
 * sub-directory holds procedural modules that are not invoked as
 * sub-agents in their own right).
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listWorkflowFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(dir, e.name));
}

/**
 * Extract the frontmatter block (between leading `---` lines) and the
 * body. Returns `{ frontmatter, body }` strings (either may be empty).
 *
 * @param {string} src
 * @returns {{ frontmatter: string, body: string }}
 */
function splitFrontmatter(src) {
  if (!src.startsWith('---')) return { frontmatter: '', body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: src };
  const frontmatter = src.slice(3, end);
  // Skip past the closing `---` and the trailing newline.
  const bodyStart = src.indexOf('\n', end + 4);
  const body = bodyStart === -1 ? '' : src.slice(bodyStart + 1);
  return { frontmatter, body };
}

/**
 * True if the workflow document declares itself as a sub-agent. We
 * accept either the literal phrase `sub-agent` in the
 * description/overview region or the explicit phrase `runs as a
 * sub-agent`. The marker has to appear early in the document — past
 * the first ~100 lines we treat the mention as historical context
 * rather than a role declaration.
 *
 * @param {string} src
 * @returns {boolean}
 */
function isSubAgentWorkflow(src) {
  const head = src.split(/\r?\n/).slice(0, 100).join('\n');
  return /\bsub-agent\b/.test(head);
}

/**
 * Inspect a workflow's `tools:` declaration (frontmatter OR inline body
 * note) for an `Agent` entry. Returns the offending textual fragment
 * (for the finding's detail field), or `null` if no `Agent` tool is
 * declared.
 *
 * @param {{ frontmatter: string, body: string }} parts
 * @returns {string | null}
 */
function findAgentToolDeclaration(parts) {
  const { frontmatter, body } = parts;
  // Frontmatter YAML — match either `tools: [..., Agent, ...]` (flow
  // style) or block style with `- Agent`.
  const flowMatch = frontmatter.match(/tools\s*:\s*\[(.*?)\]/s);
  if (flowMatch && /\bAgent\b/.test(flowMatch[1])) {
    return `frontmatter tools: ${flowMatch[0].slice(0, 120)}`;
  }
  // Block-style: `tools:` followed by `- item` lines. Use `m` flag and
  // tolerate the trailing item line having no newline before the
  // frontmatter terminator.
  const blockMatch = frontmatter.match(
    /tools\s*:\s*\n((?:[ \t]*-[ \t]*[^\n]+\n?)+)/,
  );
  if (blockMatch && /^[ \t]*-[ \t]*Agent\b/m.test(blockMatch[1])) {
    return `frontmatter tools (block): ${blockMatch[0].split('\n')[0]}`;
  }
  // Body: same shape, e.g. operators sometimes document the tool list
  // in a "## Tools" section. We accept either of the YAML shapes
  // appearing in fenced code or inline.
  const bodyFlow = body.match(/tools\s*:\s*\[(.*?)\]/s);
  if (bodyFlow && /\bAgent\b/.test(bodyFlow[1])) {
    return `body tools: ${bodyFlow[0].slice(0, 120)}`;
  }
  const bodyBlock = body.match(/tools\s*:\s*\n((?:\s*-\s*[^\n]+\n)+)/);
  if (bodyBlock && /^\s*-\s*Agent\b/m.test(bodyBlock[1])) {
    return `body tools (block): ${bodyBlock[0].split('\n')[0]}`;
  }
  return null;
}

const FIX_COMMAND = [
  '# Flatten fan-out to the host. Sub-agents cannot dispatch other agents.',
  "# Remove the `Agent` entry from this workflow's `tools:` declaration,",
  '# move any fan-out logic up to the parent / host invocation, and have',
  '# the parent dispatch the leaf sub-agents directly.',
  '#',
  '# Pattern (host workflow):',
  '#   for each child: Agent(prompt=<child workflow>, args=<id>)',
  '#',
  '# Pattern (sub-agent workflow):',
  '#   tools: [Bash, Read, Edit, Grep, Glob, Write]   # NO Agent',
].join('\n');

export default {
  id: 'subagent-agent-tool-required',
  severity: 'blocker',
  scope: ['epic-deliver', 'retro'],
  autoCorrect: 'refuse-and-print',

  detect(state) {
    const cwd = state?.cwd ?? process.cwd();
    const root = state?.scanRoot ?? path.join(cwd, WORKFLOWS_DIR_DEFAULT);
    const files = listWorkflowFiles(root);
    const offences = [];
    for (const file of files) {
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!isSubAgentWorkflow(src)) continue;
      const parts = splitFrontmatter(src);
      const where = findAgentToolDeclaration(parts);
      if (!where) continue;
      offences.push({
        file: path.relative(root, file).replace(/\\/g, '/'),
        where,
      });
    }
    if (offences.length === 0) return null;
    const detail = offences.map((o) => `${o.file} — ${o.where}`).join('\n');
    return {
      id: 'subagent-agent-tool-required',
      severity: 'blocker',
      scope: state?.scope ?? 'epic-deliver',
      summary: `${offences.length} sub-agent workflow(s) declare Agent in their tool list — nested Agent dispatch is unsupported`,
      detail,
      fixCommand: FIX_COMMAND,
      autoCorrectable: false,
    };
  },
};
