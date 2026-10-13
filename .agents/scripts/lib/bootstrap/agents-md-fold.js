/**
 * CLAUDE.md → AGENTS.md fold for bootstrap and the update migration: a
 * surviving CLAUDE.md would shadow AGENTS.md, since the host prefers it.
 *
 * @module bootstrap/agents-md-fold
 */

import fs from 'node:fs';
import path from 'node:path';

/** Entry-doc wiring keys idempotence off this exact import path. */
export const SYSTEM_PROMPT_IMPORT = '@.agents/instructions.md';

/**
 * Prose twin of the import for hosts that load AGENTS.md but expand no `@`
 * imports (Codex). The doctor's `codex-instructions` check locates the block
 * by this exact line, so it stays one line.
 */
export const SYSTEM_PROMPT_READ_DIRECTIVE =
  'Hosts that do not expand `@` imports (Codex): before any task, read `.agents/instructions.md`, `.agents/rules/security-baseline.md` and `.agents/rules/git-conventions.md` in full and follow them.';

export const SYSTEM_PROMPT_BLOCK = `## System Prompt

${SYSTEM_PROMPT_IMPORT}

${SYSTEM_PROMPT_READ_DIRECTIVE}
`;

/** The pre-2.84.0 block, which carried the import alone. */
const LEGACY_SYSTEM_PROMPT_BLOCK = `## System Prompt

${SYSTEM_PROMPT_IMPORT}
`;

/** Install template for a fresh entry doc. */
export const SYSTEM_PROMPT_ENTRY_DOC = `# Agent Protocols

${SYSTEM_PROMPT_BLOCK}`;

const ENTRY_DOC = 'AGENTS.md';
export const LEGACY_ENTRY_DOC = 'CLAUDE.md';

const SELF_IMPORT = '@AGENTS.md';

/** @type {readonly string[]} */
const BOOTSTRAP_REMOVED_PATHS = Object.freeze([LEGACY_ENTRY_DOC]);

/**
 * @param {string} text
 * @returns {string}
 */
function withTrailingNewline(text) {
  return text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Keep the first system-prompt import line, drop every later one.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function dedupeImport(lines) {
  let seen = false;
  return lines.filter((line) => {
    if (line.trim() !== SYSTEM_PROMPT_IMPORT) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

/**
 * `agents` null means AGENTS.md is absent.
 *
 * @param {{ claude: string, agents?: string|null }} input
 * @returns {string} the resulting AGENTS.md content
 */
function foldEntryDocs({ claude, agents = null }) {
  const claudeBody = claude
    .split('\n')
    .filter((line) => line.trim() !== SELF_IMPORT)
    .join('\n');
  const combined =
    typeof agents === 'string'
      ? `${withTrailingNewline(agents)}\n${claudeBody}`
      : claudeBody;
  const lines = dedupeImport(combined.split('\n'));
  const result = withTrailingNewline(lines.join('\n'));
  if (lines.some((line) => line.trim() === SYSTEM_PROMPT_IMPORT)) return result;
  return result.trim().length === 0
    ? SYSTEM_PROMPT_ENTRY_DOC
    : insertSystemPromptBlock(result);
}

/**
 * Place {@link SYSTEM_PROMPT_BLOCK} at the top of an entry doc — directly
 * after a leading H1 when there is one. Codex stops reading AGENTS.md at
 * `project_doc_max_bytes`, so an appended block in a long file never loads.
 *
 * @param {string} text - entry-doc content without the block.
 * @returns {string}
 */
function insertSystemPromptBlock(text) {
  const h1 = /^(?:[ \t]*\r?\n)*# [^\n]*\n?/.exec(text);
  const head = h1 ? withTrailingNewline(h1[0].replace(/^\s+/, '')) : '';
  const rest = text.slice(h1 ? h1[0].length : 0).replace(/^\s*\n/, '');
  const lead = head ? `${head}\n` : '';
  const tail = rest.length > 0 ? `\n${withTrailingNewline(rest)}` : '';
  return `${lead}${SYSTEM_PROMPT_BLOCK}${tail}`;
}

/**
 * Byte offset just past a leading H1 and its blank lines — where the block
 * belongs.
 *
 * @param {string} text
 * @returns {number}
 */
function topOffset(text) {
  return /^(?:\s*\n)*(?:# [^\n]*\n(?:[ \t]*\n)*)?/.exec(text)[0].length;
}

/**
 * Locate a recognizable Mandrel block (current or legacy shape).
 *
 * @param {string} text
 * @returns {{ start: number, end: number, current: boolean } | null}
 */
function findSystemPromptBlock(text) {
  for (const [block, current] of [
    [SYSTEM_PROMPT_BLOCK, true],
    [LEGACY_SYSTEM_PROMPT_BLOCK, false],
  ]) {
    const start = text.indexOf(block);
    if (start !== -1) return { start, end: start + block.length, current };
  }
  return null;
}

/**
 * True when an entry doc carries a recognizable Mandrel block that is not
 * the current block at the top — the migration's `detect`.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function needsSystemPromptHoist(text) {
  const found = findSystemPromptBlock(text);
  if (!found) return false;
  return !(found.current && found.start === topOffset(text));
}

/**
 * Move a recognizable block to the top, upgrading a legacy one. Text with no
 * recognizable block (a hand-edited import) is returned unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function hoistSystemPromptBlock(text) {
  if (!needsSystemPromptHoist(text)) return text;
  const { start, end } = findSystemPromptBlock(text);
  const without = `${text.slice(0, start)}${text.slice(end)}`.replace(
    /\n{3,}/g,
    '\n\n',
  );
  return insertSystemPromptBlock(without.replace(/\n+$/, '\n'));
}

/**
 * Fold a root CLAUDE.md into AGENTS.md on disk and delete CLAUDE.md. No-op
 * when CLAUDE.md is absent, so a second pass mutates nothing.
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {{ action: 'folded'|'none', path: string }}
 */
export function foldClaudeMdIntoAgentsMd(projectRoot, fsImpl = fs) {
  const claudePath = path.join(projectRoot, LEGACY_ENTRY_DOC);
  const agentsPath = path.join(projectRoot, ENTRY_DOC);
  if (!fsImpl.existsSync(claudePath)) {
    return { action: 'none', path: agentsPath };
  }
  const claude = fsImpl.readFileSync(claudePath, 'utf8');
  const agents = fsImpl.existsSync(agentsPath)
    ? fsImpl.readFileSync(agentsPath, 'utf8')
    : null;
  fsImpl.writeFileSync(agentsPath, foldEntryDocs({ claude, agents }), 'utf8');
  fsImpl.rmSync(claudePath, { force: true });
  return { action: 'folded', path: agentsPath };
}

/**
 * Wire the system-prompt import into AGENTS.md, folding a CLAUDE.md in first.
 * Creates, folds, inserts the block at the top, or no-ops.
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {{ action: 'created'|'folded'|'inserted'|'already-present', path: string }}
 */
export function wireEntryDoc(projectRoot, fsImpl = fs) {
  const folded = foldClaudeMdIntoAgentsMd(projectRoot, fsImpl);
  const target = folded.path;
  if (folded.action === 'folded') return folded;
  if (!fsImpl.existsSync(target)) {
    fsImpl.writeFileSync(target, SYSTEM_PROMPT_ENTRY_DOC, 'utf8');
    return { action: 'created', path: target };
  }
  const existing = fsImpl.readFileSync(target, 'utf8');
  if (existing.includes(SYSTEM_PROMPT_IMPORT)) {
    return { action: 'already-present', path: target };
  }
  fsImpl.writeFileSync(target, insertSystemPromptBlock(existing), 'utf8');
  return { action: 'inserted', path: target };
}

/**
 * Stage removal of folded-away entry docs; a failed `after` passes through.
 *
 * @param {{ after?: { ok: boolean, error?: string }, projectRoot: string, runGit: (args: string[], cwd: string) => { ok: boolean, stderr?: string }, fsImpl?: typeof fs }} args
 * @returns {{ ok: boolean, error?: string, removed: string[] }}
 */
export function stageLegacyEntryDocRemoval({
  projectRoot,
  runGit,
  fsImpl = fs,
  after = { ok: true },
}) {
  if (!after.ok) return after;
  const removed = BOOTSTRAP_REMOVED_PATHS.filter(
    (rel) => !fsImpl.existsSync(path.join(projectRoot, rel)),
  );
  if (removed.length === 0) return { ok: true, removed };
  const result = runGit(
    ['rm', '--cached', '--ignore-unmatch', '--quiet', '--', ...removed],
    projectRoot,
  );
  return { ok: result.ok, error: result.stderr || 'git rm failed', removed };
}
