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

export const SYSTEM_PROMPT_BLOCK = `## System Prompt

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
  let result = withTrailingNewline(lines.join('\n'));
  if (!lines.some((line) => line.trim() === SYSTEM_PROMPT_IMPORT)) {
    result =
      result.trim().length === 0
        ? SYSTEM_PROMPT_ENTRY_DOC
        : `${result}\n${SYSTEM_PROMPT_BLOCK}`;
  }
  return result;
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
 * Creates, folds, appends, or no-ops.
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {{ action: 'created'|'folded'|'appended'|'already-present', path: string }}
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
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fsImpl.writeFileSync(
    target,
    `${existing}${separator}\n${SYSTEM_PROMPT_BLOCK}`,
    'utf8',
  );
  return { action: 'appended', path: target };
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
