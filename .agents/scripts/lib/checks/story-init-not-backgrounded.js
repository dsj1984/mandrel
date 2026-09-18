/**
 * Flags call sites that background `single-story-init.js` instead of calling
 * it synchronously: a sub-agent exiting during a `Monitor` wait kills init
 * mid-run and leaves a half-initialized worktree. Refuse-and-print, since
 * rewriting a call site would change behaviour the operator may be editing.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

const SCAN_ROOT_DEFAULT = '.agents';
const WINDOW_LINES = 20;

/**
 * Invocation syntax only, never prose like "do not use Monitor" that docs
 * legitimately carry.
 */
const BACKGROUND_TOKENS = [
  /run_in_background\s*:\s*true/,
  /detached\s*:\s*true/,
  /story-init\.js[^\n`]*[ \t]&[ \t]*(?:#|$)/m,
];

/**
 * @param {string} dir
 * @param {typeof nodeFs} [fsImpl]
 * @returns {string[]}
 */
export function walkSources(dir, fsImpl = nodeFs) {
  const out = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.worktrees' ||
        entry.name.startsWith('.git')
      ) {
        continue;
      }
      out.push(...walkSources(full, fsImpl));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(js|mjs|cjs|md)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Every `story-init.js` line with a backgrounding token within ±WINDOW_LINES.
 *
 * @param {string} file
 * @param {string} src
 * @returns {Array<{ line: number, kind: string }>}
 */
export function scanFile(file, src) {
  const offences = [];
  // Skip the script, this check, and parallel-tooling.md, whose adjacent
  // prose bullets fall inside one window with no real invocation.
  const basename = path.basename(file);
  if (
    basename === 'single-story-init.js' ||
    basename === 'story-init-not-backgrounded.js' ||
    basename === 'story-init-not-backgrounded.test.js' ||
    basename === 'parallel-tooling.md'
  ) {
    return offences;
  }
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/story-init\.js/.test(lines[i])) continue;
    const start = Math.max(0, i - WINDOW_LINES);
    const end = Math.min(lines.length, i + WINDOW_LINES + 1);
    const window = lines.slice(start, end).join('\n');
    for (const tok of BACKGROUND_TOKENS) {
      if (tok.test(window)) {
        offences.push({ line: i + 1, kind: tok.source });
        break;
      }
    }
  }
  return offences;
}

const FIX_COMMAND = [
  '# Invoke single-story-init.js synchronously with a 10-minute timeout.',
  '# The script is idempotent on partial state, so re-running after a',
  '# half-initialized worktree is safe — but blocking on the Bash call',
  '# is what prevents the half-init state in the first place.',
  '#',
  '# Replacement pattern (Bash tool):',
  '#   Bash(timeout: 600000, command: "node .agents/scripts/single-story-init.js --story <id>")',
  '#',
  '# Do NOT use:',
  '#   Bash(run_in_background: true, ...) + Monitor(...)',
].join('\n');

export default {
  id: 'story-init-not-backgrounded',
  severity: 'blocker',
  scope: ['story-close', 'retro'],
  autoCorrect: 'refuse-and-print',

  /**
   * @param {{ cwd?: string, scanRoot?: string, scope?: string }} [state]
   * @param {typeof nodeFs} [fsImpl]
   */
  detect(state, fsImpl = nodeFs) {
    const cwd = state?.cwd ?? process.cwd();
    const root = state?.scanRoot ?? path.join(cwd, SCAN_ROOT_DEFAULT);
    const files = walkSources(root, fsImpl);
    const offences = [];
    for (const file of files) {
      let src;
      try {
        src = fsImpl.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!/story-init\.js/.test(src)) continue;
      const fileOffences = scanFile(file, src);
      for (const o of fileOffences) {
        offences.push({
          file: path.relative(root, file).replace(/\\/g, '/'),
          line: o.line,
          kind: o.kind,
        });
      }
    }
    if (offences.length === 0) return null;
    const detail = offences
      .map((o) => `${o.file}:${o.line} — backgrounding token /${o.kind}/`)
      .join('\n');
    return {
      id: 'story-init-not-backgrounded',
      severity: 'blocker',
      scope: state?.scope ?? 'story-close',
      summary: `${offences.length} orchestration call site(s) invoke single-story-init.js with Monitor backgrounding`,
      detail,
      fixCommand: FIX_COMMAND,
      autoCorrectable: false,
    };
  },
};
