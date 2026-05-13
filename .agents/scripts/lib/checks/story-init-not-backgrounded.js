/**
 * story-init-not-backgrounded — refuse-and-print check.
 *
 * Detects orchestration call sites that invoke `story-init.js` via the
 * Bash tool's `run_in_background: true` mode (with subsequent `Monitor`
 * waiting on completion) instead of a synchronous Bash call with a
 * 10-minute timeout. This guards the failure mode where `Monitor`'s wait
 * is not equivalent to script exit — a sub-agent that exits during a
 * Monitor wait kills `story-init.js` mid-batch, leaving a half-initialized
 * worktree and a failed wave aggregator.
 *
 * Scope: 'epic-deliver', 'story-close', 'retro'. The check runs at every
 * preflight surface that has the opportunity to invoke story-init —
 * primarily `epic-deliver`'s wave loop — and surfaces as a retro audit
 * signal if the failure mode resurfaces during a sprint.
 *
 * The check is `refuse-and-print`. Auto-rewriting an orchestration call
 * site would change runtime behavior on a script the operator may be
 * actively iterating on; the fixCommand prints the canonical
 * synchronous-call replacement pattern so they can apply it deliberately.
 *
 * Implementation note: we scan `.agents/` (markdown + js) for the
 * juxtaposition of a `story-init.js` reference and a backgrounding token
 * (`run_in_background: true`, the literal `Monitor` tool name as a
 * fan-out target, or `&` shell backgrounding) within a small line window.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SCAN_ROOT_DEFAULT = '.agents';
const WINDOW_LINES = 20;

/**
 * Backgrounding tokens. We only match shapes that are unambiguously
 * *invocation* syntax, never narrative prose like "do not use Monitor"
 * (which legitimately appears in docs warning against the antipattern).
 *
 * - `run_in_background: true` — Bash tool's backgrounding flag.
 * - `detached: true` — child_process.spawn options that detach the
 *   subprocess from the parent's lifecycle, equivalent to backgrounding.
 * - `story-init.js &` — POSIX shell ampersand backgrounding.
 */
const BACKGROUND_TOKENS = [
  /run_in_background\s*:\s*true/,
  /detached\s*:\s*true/,
  /story-init\.js[^\n`]*[ \t]&[ \t]*(?:#|$)/m,
];

/**
 * Walk a directory recursively, yielding absolute file paths for `.js`
 * and `.md` sources. Skips `node_modules`, `.worktrees`, and directories
 * starting with `.git`.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walkSources(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
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
      out.push(...walkSources(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(js|mjs|cjs|md)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * For one file, return an array of `{ line, kind }` offences: every line
 * referencing `story-init.js` that has a backgrounding token in the same
 * ±WINDOW_LINES window.
 *
 * The check explicitly excludes the `story-init.js` file itself and any
 * dedicated check module (this file): the source-of-truth implementation
 * legitimately mentions itself.
 *
 * @param {string} file
 * @param {string} src
 * @returns {Array<{ line: number, kind: string }>}
 */
function scanFile(file, src) {
  const offences = [];
  // Don't flag the actual story-init script, self-references, or the
  // parallel-tooling helper — the helper documents both Rule 2
  // (run_in_background) and the story-init.js anti-pattern in adjacent
  // bullets, which collides with the scanner's ±20-line window even
  // though there is no real invocation in the prose.
  const basename = path.basename(file);
  if (
    basename === 'story-init.js' ||
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
  '# Invoke story-init.js synchronously with a 10-minute timeout. The',
  '# script is idempotent on partial state, so re-running after a',
  '# half-initialized worktree is safe — but blocking on the Bash call',
  '# is what prevents the half-init state in the first place.',
  '#',
  '# Replacement pattern (Bash tool):',
  '#   Bash(timeout: 600000, command: "node .agents/scripts/story-init.js --story <id>")',
  '#',
  '# Do NOT use:',
  '#   Bash(run_in_background: true, ...) + Monitor(...)',
].join('\n');

export default {
  id: 'story-init-not-backgrounded',
  severity: 'blocker',
  scope: ['epic-deliver', 'story-close', 'retro'],
  autoCorrect: 'refuse-and-print',

  detect(state) {
    const cwd = state?.cwd ?? process.cwd();
    const root = state?.scanRoot ?? path.join(cwd, SCAN_ROOT_DEFAULT);
    const files = walkSources(root);
    const offences = [];
    for (const file of files) {
      let src;
      try {
        src = readFileSync(file, 'utf8');
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
      scope: state?.scope ?? 'epic-deliver',
      summary: `${offences.length} orchestration call site(s) invoke story-init.js with Monitor backgrounding`,
      detail,
      fixCommand: FIX_COMMAND,
      autoCorrectable: false,
    };
  },
};
