/**
 * Flags a sub-agent workflow that declares `Agent` with a fan-out deeper than
 * the supported nesting ceiling — such a chain fails silently at runtime.
 * Nested dispatch at a supported depth is legitimate. Refuse-and-print:
 * rewriting depth or tools would change runtime behaviour unasked.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR_DEFAULT = path.join('.agents', 'workflows');

/**
 * Harness-announced ceiling (only depth 2 is verified); `state.supportedDepth` overrides.
 *
 * @type {number}
 */
export const ANNOUNCED_MAX_DEPTH = 5;

/**
 * Non-recursive: `helpers/` modules are never sub-agents themselves.
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
 * @param {string} src
 * @returns {{ frontmatter: string, body: string }}
 */
function splitFrontmatter(src) {
  if (!src.startsWith('---')) return { frontmatter: '', body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: src };
  const frontmatter = src.slice(3, end);
  const bodyStart = src.indexOf('\n', end + 4);
  const body = bodyStart === -1 ? '' : src.slice(bodyStart + 1);
  return { frontmatter, body };
}

/**
 * `sub-agent` within the first 100 lines is a role declaration; later
 * mentions are context.
 *
 * @param {string} src
 * @returns {boolean}
 */
function isSubAgentWorkflow(src) {
  const head = src.split(/\r?\n/).slice(0, 100).join('\n');
  return /\bsub-agent\b/.test(head);
}

/**
 * Find an `Agent` entry in a flow- or block-style `tools:` list, in
 * frontmatter or body; returns the fragment for the finding detail.
 *
 * @param {{ frontmatter: string, body: string }} parts
 * @returns {string | null}
 */
function findAgentToolDeclaration(parts) {
  const { frontmatter, body } = parts;
  const flowMatch = frontmatter.match(/tools\s*:\s*\[(.*?)\]/s);
  if (flowMatch && /\bAgent\b/.test(flowMatch[1])) {
    return `frontmatter tools: ${flowMatch[0].slice(0, 120)}`;
  }
  // The last item may lack a newline before the frontmatter terminator.
  const blockMatch = frontmatter.match(
    /tools\s*:\s*\n((?:[ \t]*-[ \t]*[^\n]+\n?)+)/,
  );
  if (blockMatch && /^[ \t]*-[ \t]*Agent\b/m.test(blockMatch[1])) {
    return `frontmatter tools (block): ${blockMatch[0].split('\n')[0]}`;
  }
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
 * From a `nesting-depth:`/`agent-depth:` frontmatter field or a
 * `<!-- nesting-depth: N -->` body marker; `null` when undeclared.
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
  scope: ['retro'],
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
      // An undeclared depth is the shallow level-1 fan-out.
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
      scope: state?.scope ?? 'retro',
      summary: `${offences.length} sub-agent workflow(s) declare an Agent fan-out deeper than the supported nesting ceiling (${ceiling})`,
      detail,
      fixCommand: FIX_COMMAND,
      autoCorrectable: false,
    };
  },
};
