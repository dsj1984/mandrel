// lib/cli/doctor-checks/codex.js — Doctor checks: codex-skills-in-sync, codex-agents-in-sync, codex-instructions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SYSTEM_PROMPT_IMPORT,
  SYSTEM_PROMPT_READ_DIRECTIVE,
} from '../../../.agents/scripts/lib/bootstrap/agents-md-fold.js';
import {
  CODEX_AGENTS_DIR,
  expectedCodexAgents,
  listGeneratedCodexAgents,
} from '../../../.agents/scripts/lib/codex/agents-projection.js';
import {
  CODEX_SKILLS_DIR,
  expectedCodexSkills,
  listGeneratedCodexSkills,
} from '../../../.agents/scripts/lib/codex/skills-projection.js';

// check: codex-skills-in-sync / codex-agents-in-sync (and the Claude twins)

/**
 * Compare a generated tree against what its projector would write now,
 * byte-for-byte. Shared by both hosts' parity checks.
 * `readEntry(name)` returns the on-disk text or null.
 *
 * @param {{
 *   expected: () => Map<string, string>,
 *   onDisk: string[],
 *   readEntry: (name: string) => string | null,
 *   noun: string,
 *   where: string,
 *   remedy: string,
 * }} spec
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function projectionParity({
  expected,
  onDisk,
  readEntry,
  noun,
  where,
  remedy,
}) {
  let want;
  try {
    want = expected();
  } catch (err) {
    return { ok: false, detail: err.message, remedy };
  }
  const have = new Set(onDisk);
  const missing = [...want.keys()].filter((n) => !have.has(n));
  const stale = [...want.entries()].filter(
    ([n, body]) => have.has(n) && readEntry(n) !== body,
  );
  const extra = onDisk.filter((n) => !want.has(n));
  if (missing.length + stale.length + extra.length === 0) {
    return { ok: true, detail: `${want.size} ${noun} up to date in ${where}` };
  }
  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} not synced`);
  if (stale.length + extra.length > 0) {
    parts.push(`${stale.length + extra.length} stale`);
  }
  return { ok: false, detail: `${parts.join(', ')} in ${where}`, remedy };
}

/**
 * @param {string} file
 * @returns {string | null}
 */
export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parity of `.agents/skills/workflows/` against the workflow set — the Codex
 * twin of `commands-in-sync`.
 *
 * @param {{ projectRoot?: string, cwd?: () => string }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runCodexSkillsInSync({ projectRoot, cwd } = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const destDir = path.join(root, ...CODEX_SKILLS_DIR.split('/'));
  return projectionParity({
    expected: () => expectedCodexSkills({ projectRoot: root }),
    onDisk: listGeneratedCodexSkills(destDir),
    readEntry: (name) => readTextOrNull(path.join(destDir, name, 'SKILL.md')),
    noun: 'Codex skills',
    where: `${CODEX_SKILLS_DIR}/`,
    remedy: `Run \`mandrel sync-commands\` to regenerate the Codex skills under \`${CODEX_SKILLS_DIR}/\`.`,
  });
}

/**
 * Parity of `.codex/agents/mandrel-*.toml` against `.agents/agents/` — the
 * Codex twin of `agents-in-sync`.
 *
 * @param {{ projectRoot?: string, cwd?: () => string }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runCodexAgentsInSync({ projectRoot, cwd } = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const destDir = path.join(root, ...CODEX_AGENTS_DIR.split('/'));
  return projectionParity({
    expected: () => expectedCodexAgents({ projectRoot: root }),
    onDisk: listGeneratedCodexAgents(destDir),
    readEntry: (name) => readTextOrNull(path.join(destDir, name)),
    noun: 'Codex agents',
    where: `${CODEX_AGENTS_DIR}/`,
    remedy: `Run \`mandrel sync-agents\` to regenerate \`${CODEX_AGENTS_DIR}/mandrel-<role>.toml\`.`,
  });
}

// check: codex-instructions

/** Codex's default `project_doc_max_bytes`. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32768;

/**
 * A top-level `project_doc_max_bytes = <int>` line before any `[table]`
 * header; anything else (absent file, nested key, non-integer) is null. No
 * TOML dependency — this one key is all the check needs.
 *
 * @param {string | null} text
 * @returns {number | null}
 */
export function readProjectDocMaxBytes(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return null;
    const match = /^\s*project_doc_max_bytes\s*=\s*(\d+)\s*(?:#.*)?$/.exec(
      line,
    );
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Effective limit and where it came from: project `.codex/config.toml`, then
 * `$CODEX_HOME/config.toml` (default `~/.codex`), else the default.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {string} homeDir
 * @param {(file: string) => string | null} readText
 * @returns {{ limit: number, source: string }}
 */
function resolveProjectDocLimit(root, env, homeDir, readText) {
  const codexHome = env.CODEX_HOME || path.join(homeDir, '.codex');
  for (const [file, source] of [
    [path.join(root, '.codex', 'config.toml'), '.codex/config.toml'],
    [path.join(codexHome, 'config.toml'), '$CODEX_HOME/config.toml'],
  ]) {
    const limit = readProjectDocMaxBytes(readText(file));
    if (limit !== null) return { limit, source };
  }
  return { limit: CODEX_PROJECT_DOC_MAX_BYTES, source: 'the Codex default' };
}

const HOIST_REMEDY =
  'Move the `## System Prompt` block to the top of the file, or run `mandrel update` (its 2.84.0 migration moves it).';

/**
 * Does Codex load the Mandrel block? Sizes the root `AGENTS.override.md`, else
 * `AGENTS.md`, against the effective `project_doc_max_bytes`. Fails when the
 * block (import through read directive) does not end inside the limit, or
 * carries no directive Codex can follow; an oversized file whose block still
 * loads passes with an advisory. No entry doc at all skips, as
 * `claude-code-version` does.
 *
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   readText?: (file: string) => string | null,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runCodexInstructions({
  projectRoot,
  cwd,
  env = process.env,
  homeDir = os.homedir(),
  readText = readTextOrNull,
} = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const { limit, source } = resolveProjectDocLimit(
    root,
    env,
    homeDir,
    readText,
  );
  const override = readText(path.join(root, 'AGENTS.override.md'));
  const docName = override === null ? 'AGENTS.md' : 'AGENTS.override.md';
  const text = override ?? readText(path.join(root, 'AGENTS.md'));
  if (text === null) {
    return { ok: true, detail: 'skipped: no AGENTS.md' };
  }
  const importAt = text.indexOf(SYSTEM_PROMPT_IMPORT);
  const directiveAt = text.indexOf(SYSTEM_PROMPT_READ_DIRECTIVE);
  if (importAt === -1 || directiveAt === -1) {
    return {
      ok: false,
      detail: `${docName} carries no Mandrel read directive for hosts without @-imports — Codex would not load .agents/instructions.md`,
      remedy: HOIST_REMEDY,
    };
  }
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const start = bytes(text.slice(0, Math.min(importAt, directiveAt)));
  const end = bytes(
    text.slice(0, directiveAt + SYSTEM_PROMPT_READ_DIRECTIVE.length),
  );
  const total = bytes(text);
  const limitLabel = `project_doc_max_bytes ${limit} (${source})`;
  if (end > limit) {
    return {
      ok: false,
      detail: `the Mandrel block in ${docName} spans bytes ${start}–${end}, beyond ${limitLabel} — Codex never reads it`,
      remedy: HOIST_REMEDY,
    };
  }
  if (total > limit) {
    return {
      ok: true,
      detail: `${docName} is ${total} bytes, over ${limitLabel}: the Mandrel block (bytes ${start}–${end}) loads, the last ${total - limit} bytes do not — raise project_doc_max_bytes in .codex/config.toml to load them`,
    };
  }
  return {
    ok: true,
    detail: `${docName} is ${total} bytes, within ${limitLabel}; the Mandrel block loads`,
  };
}
