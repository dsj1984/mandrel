/**
 * subagent-agent-tool-required — supported-depth guard (refuse-and-print).
 *
 * Nested `Agent` dispatch from a sub-agent is **supported** on this Claude
 * Code build (verified depth 2, announced max depth 5 — Claude Code
 * 2.1.202, re-spiked 2026-07-08; see Epic #4385 / watch #2870). A level-1
 * sub-agent carries `Agent` in its primary toolset and can spawn a working
 * level-2 sub-agent. Declaring `Agent` in a sub-agent workflow is therefore
 * a legitimate design choice, **not** an automatic runtime failure.
 *
 * What this check guards is the one case that still fails: a fan-out whose
 * declared nesting depth exceeds the announced/supported ceiling. A dispatch
 * chain deeper than the harness supports will silently fail at runtime, so a
 * workflow that declares `Agent` together with a `nesting-depth` beyond the
 * ceiling is flagged as a blocker. A sub-agent that declares `Agent` at a
 * supported depth (the common case — an undeclared depth is treated as the
 * shallow level-1 fan-out) produces no finding.
 *
 * This inverts the historical guard (Story #4387): the check used to refuse
 * `Agent` in *any* sub-agent workflow on the now-false rationale that
 * sub-agents cannot dispatch. It no longer strips a real capability; it only
 * catches an over-deep fan-out. The self-healing surface is preserved — it is
 * re-scoped, not removed.
 *
 * Scope: 'epic-deliver', 'retro'. Surfaces as a blocker at preflight for
 * `epic-deliver` (the fan-out site) and as audit signal at retro.
 *
 * The check is `refuse-and-print` — auto-rewriting a workflow's declared
 * depth or tool list would silently change runtime behavior in ways the
 * operator may not have intended. The fixCommand explains how to bring the
 * fan-out back under the ceiling (reduce the declared depth or split the
 * deepest level out), and is explicit that stripping `Agent` is NOT the fix.
 *
 * Implementation note: we scan `.agents/workflows/*.md` for workflow files
 * whose frontmatter or body identifies them as a sub-agent role AND whose
 * `tools:` declaration includes `Agent`, then read the workflow's declared
 * `nesting-depth`. The marker for "sub-agent" is the phrase `sub-agent`
 * appearing in the description / overview region. The depth is read from a
 * `nesting-depth:` (or `agent-depth:`) frontmatter field, or a
 * `<!-- nesting-depth: N -->` body marker; an absent declaration is treated
 * as depth 1 (a single, shallow fan-out level).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR_DEFAULT = path.join('.agents', 'workflows');

/**
 * Announced maximum nesting depth the Claude Code harness supports for
 * sub-agent fan-out. Depth 2 is independently verified; depths 3–5 are
 * announced but not yet re-spiked (Epic #4385 / watch #2870). A workflow
 * declaring a fan-out deeper than this ceiling is flagged. Operators can pin
 * a stricter (or, once verified, looser) ceiling via `state.supportedDepth`.
 *
 * @type {number}
 */
export const ANNOUNCED_MAX_DEPTH = 5;

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

/**
 * Parse the workflow's declared nesting depth. A sub-agent that declares
 * `Agent` may also declare how deep its fan-out reaches via a
 * `nesting-depth:` (or `agent-depth:`) frontmatter field, or a
 * `<!-- nesting-depth: N -->` marker in the body. Returns the integer
 * depth, or `null` when no depth is declared (the caller treats an absent
 * declaration as the shallow level-1 fan-out).
 *
 * @param {{ frontmatter: string, body: string }} parts
 * @returns {number | null}
 */
function parseDeclaredDepth(parts) {
  const { frontmatter, body } = parts;
  const fmMatch = frontmatter.match(
    /^[ \t]*(?:nesting-depth|agent-depth)\s*:\s*(\d+)\s*$/m,
  );
  if (fmMatch) return Number.parseInt(fmMatch[1], 10);
  const bodyMatch = body.match(
    /<!--\s*(?:nesting-depth|agent-depth)\s*:\s*(\d+)\s*-->/,
  );
  if (bodyMatch) return Number.parseInt(bodyMatch[1], 10);
  return null;
}

/**
 * Resolve the supported depth ceiling for a detect run. Operators may pin a
 * stricter (or, once verified, looser) ceiling via `state.supportedDepth`;
 * an unset or non-positive-integer override falls back to the announced max.
 *
 * @param {{ supportedDepth?: unknown } | null | undefined} state
 * @returns {number}
 */
function resolveCeiling(state) {
  const override = state?.supportedDepth;
  if (Number.isInteger(override) && override > 0) return override;
  return ANNOUNCED_MAX_DEPTH;
}

const FIX_COMMAND = [
  '# Nested Agent dispatch IS supported (verified depth 2, announced max 5 —',
  '# Claude Code 2.1.202). This workflow declares a fan-out deeper than the',
  '# supported ceiling, so the deepest dispatch chain will fail at runtime.',
  '#',
  '# Bring the fan-out back under the ceiling — either:',
  '#   1. Lower the declared `nesting-depth` to <= the supported ceiling, or',
  '#   2. Split the deepest level out to a shallower sibling fan-out so no',
  '#      single dispatch chain exceeds the supported depth.',
  '#',
  '# Do NOT strip `Agent` from the tool list to silence this. Sub-agents CAN',
  '# dispatch nested agents at a supported depth; removing the tool would',
  '# disable a legitimate capability, not fix the depth overflow.',
].join('\n');

export default {
  id: 'subagent-agent-tool-required',
  severity: 'blocker',
  scope: ['epic-deliver', 'retro'],
  autoCorrect: 'refuse-and-print',

  detect(state) {
    const cwd = state?.cwd ?? process.cwd();
    const root = state?.scanRoot ?? path.join(cwd, WORKFLOWS_DIR_DEFAULT);
    const ceiling = resolveCeiling(state);
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
      // Declaring `Agent` is legitimate. Only a fan-out deeper than the
      // supported ceiling is a runtime hazard; an undeclared depth is the
      // shallow level-1 fan-out and always within the ceiling.
      const depth = parseDeclaredDepth(parts) ?? 1;
      if (depth <= ceiling) continue;
      offences.push({
        file: path.relative(root, file).replace(/\\/g, '/'),
        where,
        depth,
      });
    }
    if (offences.length === 0) return null;
    const detail = offences
      .map(
        (o) =>
          `${o.file} — declares Agent at nesting-depth ${o.depth} (exceeds supported ceiling ${ceiling}); ${o.where}`,
      )
      .join('\n');
    return {
      id: 'subagent-agent-tool-required',
      severity: 'blocker',
      scope: state?.scope ?? 'epic-deliver',
      summary: `${offences.length} sub-agent workflow(s) declare an Agent fan-out deeper than the supported nesting ceiling (${ceiling})`,
      detail,
      fixCommand: FIX_COMMAND,
      autoCorrectable: false,
    };
  },
};
