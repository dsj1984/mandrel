// lib/cli/claude-code-version.js
/**
 * `mandrel doctor` check `claude-code-version`: an AGENTS.md-only project
 * needs a Claude Code host that loads AGENTS.md at all. Below the floor the
 * framework never hydrates, so the check fails. A missing `claude` binary,
 * unparseable output, or a project still carrying CLAUDE.md skips with
 * `ok: true` so headless/CI hosts are never blocked. The `claude --version`
 * spawn goes through the injected `runner` (fixed argv, never user input);
 * with neither `runner` nor `runClaude` the check skips.
 *
 * @module cli/claude-code-version
 */

import fs from 'node:fs';
import path from 'node:path';

import { compareVersions } from './version-helpers.js';

/** Oldest Claude Code release that loads a root AGENTS.md. */
export const CLAUDE_CODE_AGENTS_MD_FLOOR = '2.1.277';

/**
 * @param {string} text
 * @returns {string|null} the leading `x.y.z`, or null
 */
export function parseClaudeVersion(text) {
  const match = /^\s*v?(\d+\.\d+\.\d+)/.exec(text ?? '');
  return match ? match[1] : null;
}

/**
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   existsSync?: (p: string) => boolean,
 *   runner?: (cmd: string, args: string[], opts?: object) => unknown,
 *   runClaude?: () => { status: number|null, stdout: string, error?: NodeJS.ErrnoException } | Promise<{ status: number|null, stdout: string, error?: NodeJS.ErrnoException }>,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, detail: string, remedy?: string }>}
 */
export async function runClaudeCodeVersion({
  projectRoot,
  cwd = () => process.cwd(),
  existsSync = fs.existsSync,
  runner = () => ({ status: null, stdout: '', error: new Error('none') }),
  runClaude = () =>
    runner('claude', ['--version'], {
      shell: process.platform === 'win32',
      timeout: 10_000,
    }),
} = {}) {
  const root = projectRoot ?? cwd();
  if (existsSync(path.join(root, 'CLAUDE.md'))) {
    return { ok: true, detail: 'skipped: CLAUDE.md present' };
  }
  if (!existsSync(path.join(root, 'AGENTS.md'))) {
    return { ok: true, detail: 'skipped: no AGENTS.md' };
  }
  const r = await runClaude();
  if (r.error || r.status !== 0) {
    return { ok: true, detail: 'skipped: claude not found on PATH' };
  }
  const version = parseClaudeVersion(r.stdout);
  if (!version) {
    return {
      ok: true,
      detail: 'skipped: unparseable `claude --version` output',
    };
  }
  const detail = `Claude Code ${version} (required >=${CLAUDE_CODE_AGENTS_MD_FLOOR} to load AGENTS.md)`;
  if (compareVersions(version, CLAUDE_CODE_AGENTS_MD_FLOOR) >= 0) {
    return { ok: true, detail };
  }
  return {
    ok: false,
    detail,
    remedy: `Upgrade Claude Code to >=${CLAUDE_CODE_AGENTS_MD_FLOOR} (e.g. \`claude update\`) — older hosts do not load AGENTS.md, so the framework never hydrates.`,
  };
}
