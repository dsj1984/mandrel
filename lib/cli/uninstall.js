// lib/cli/uninstall.js
/**
 * `mandrel uninstall` subcommand.
 *
 * Reverses a recorded install by consuming the install ledger written by the
 * consent-first bootstrap (`.agents/.install-manifest.json`, Story #3524).
 * Each ledger entry is a mutation-manifest record
 * (`{ phaseGroup, target, action, reversible }`); uninstall walks the
 * reversible entries and undoes exactly the mutation the install applied,
 * keyed off the entry's `target` path.
 *
 * Design goals
 * ------------
 * - **Preserve pre-existing user content.** Reversal is marker-based, not
 *   blunt file deletion: the CLAUDE.md import block is stripped (not the file
 *   removed) so a CLAUDE.md the operator authored before install survives;
 *   the `.claude/settings.json` sync hook is spliced out without touching
 *   other hooks; the `.gitignore` entries are removed without disturbing the
 *   operator's own ignore rules; only the framework's own npm scripts are
 *   removed from `package.json`. A file is deleted outright only when
 *   stripping the framework block leaves it empty / framework-only (the
 *   install created it from nothing).
 * - **GitHub-side state is never touched by default.** The `github-admin`
 *   ledger entries carry `reversible: false`; they are surfaced as a manual
 *   rollback checklist and are only acted on when the operator opts in with
 *   `--include-github` (which, for now, still only enumerates them — remote
 *   admin reversal is out of scope for this Story and would require the same
 *   `gh` plumbing the bootstrap uses).
 * - **Idempotent.** Re-running after a successful uninstall is a no-op: the
 *   ledger is removed last, and every reversal step is a no-op when the
 *   marker is already absent.
 *
 * Output contract
 * ---------------
 *   reversed file → "✔  reverted <target>   <detail>"
 *   skipped       → "•  skipped  <target>   <reason>"
 *   manual (gh)   → "!  manual   <target>   <detail>"
 *   final         → "✅  Uninstalled (<n> reversed, <m> manual follow-ups)"
 *                  | "❌  No install ledger found — nothing to uninstall."
 *
 * All output goes to process.stdout (never console.log — the repo enforces a
 * no-console rule). Exit code 0 on success (including the no-ledger case,
 * which is a benign no-op), 1 only on an unrecoverable error.
 *
 * Injectable seams (used by tests so no real filesystem is touched):
 *   - `projectRoot`  — overrides the resolved consumer root.
 *   - `fsImpl`       — replaces the `node:fs` surface.
 *   - `write`        — replaces process.stdout.write.
 *   - `exit`         — replaces process.exit.
 *   - `includeGithub`— forces the --include-github behaviour.
 *
 * @module cli/uninstall
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_SCHEMA_VERSION,
  ledgerPath,
  readInstallLedger,
} from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import {
  BOOTSTRAP_COMMAND,
  GITIGNORE_BLOCKS,
  SYNC_COMMAND,
  SYSTEM_PROMPT_BLOCK,
  SYSTEM_PROMPT_CLAUDE_MD,
  SYSTEM_PROMPT_IMPORT,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import {
  DOWNSTREAM_PRE_COMMIT,
  PRE_COMMIT_MARKER,
  QUALITY_NPM_SCRIPTS,
} from '../../.agents/scripts/lib/bootstrap/quality-bootstrap.js';

// ---------------------------------------------------------------------------
// Project-root resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the consumer project root — the directory that holds `.agents/`.
 * `mandrel uninstall` runs from the consumer's checkout, so the install
 * ledger and every target path are anchored at `process.cwd()`. This mirrors
 * how `lib/cli/sync.js` and the doctor checks anchor consumer-facing paths.
 *
 * @param {() => string} [cwd=process.cwd]
 * @returns {string}
 */
function resolveProjectRoot(cwd = () => process.cwd()) {
  return cwd();
}

// ---------------------------------------------------------------------------
// npm-script removal set
// ---------------------------------------------------------------------------

/**
 * The exact `package.json` scripts the bootstrap seeds. Reversal removes a
 * script key only when its value still equals the framework-seeded command —
 * an operator who overwrote the value keeps their version. `prepare` is
 * special: the bootstrap may *append* the sync command to an existing
 * `prepare`, so reversal strips the framework fragment rather than deleting
 * the whole key. Mirrors `ensurePackageJson` / `ensureQualityNpmScripts`.
 *
 * @type {Readonly<Record<string, string>>}
 */
const FRAMEWORK_NPM_SCRIPTS = Object.freeze({
  'sync:commands': SYNC_COMMAND,
  bootstrap: BOOTSTRAP_COMMAND,
  ...QUALITY_NPM_SCRIPTS,
});

// ---------------------------------------------------------------------------
// Pure reversal helpers (filesystem effects via the injected fsImpl)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ReversalOutcome
 * @property {'reverted'|'skipped'|'manual'} kind
 * @property {string} target
 * @property {string} detail
 */

/**
 * Strip the framework system-prompt import block from a `CLAUDE.md`. The file
 * is removed only when it is byte-identical to the install-authored template
 * (`SYSTEM_PROMPT_CLAUDE_MD`). Any other file — including one whose only
 * operator content is markdown headings — is preserved with just the framework
 * block excised.
 *
 * Using a byte-equality check rather than a "non-`#` meaningful lines"
 * heuristic prevents data loss when an operator's pre-install `CLAUDE.md`
 * consists entirely of markdown headings (all lines start with `#`).
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertClaudeMd(projectRoot, fsImpl) {
  const target = path.join(projectRoot, 'CLAUDE.md');
  const rel = 'CLAUDE.md';
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'file absent' };
  }
  const original = fsImpl.readFileSync(target, 'utf8');
  if (!original.includes(SYSTEM_PROMPT_IMPORT)) {
    return { kind: 'skipped', target: rel, detail: 'import already absent' };
  }
  // Delete only when the file is exactly the install-authored template — i.e.
  // the install created it from nothing. Operator-authored content (even an
  // all-headings file) must survive.
  if (original.trim() === SYSTEM_PROMPT_CLAUDE_MD.trim()) {
    fsImpl.rmSync(target, { force: true });
    return {
      kind: 'reverted',
      target: rel,
      detail: 'removed install-created CLAUDE.md',
    };
  }
  // Remove the full block first (heading + import), then fall back to the
  // bare import line so a hand-edited block without the heading still clears.
  let next = original.includes(SYSTEM_PROMPT_BLOCK)
    ? original.replace(SYSTEM_PROMPT_BLOCK, '')
    : original;
  if (next.includes(SYSTEM_PROMPT_IMPORT)) {
    next = next
      .split('\n')
      .filter((line) => line.trim() !== SYSTEM_PROMPT_IMPORT)
      .join('\n');
  }
  // Collapse any run of 3+ blank lines the splice may have produced.
  next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  fsImpl.writeFileSync(
    target,
    next.endsWith('\n') ? next : `${next}\n`,
    'utf8',
  );
  return {
    kind: 'reverted',
    target: rel,
    detail: 'stripped system-prompt import block',
  };
}

/**
 * Splice the framework UserPromptSubmit sync hook out of
 * `.claude/settings.json`, leaving every other hook and setting intact. When
 * the settings file is left with no hooks and no other keys, it is removed.
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertClaudeSettings(projectRoot, fsImpl) {
  const target = path.join(projectRoot, '.claude', 'settings.json');
  const rel = '.claude/settings.json';
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'file absent' };
  }
  const settings = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  const groups = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) {
    return { kind: 'skipped', target: rel, detail: 'sync hook absent' };
  }
  const isFrameworkHook = (h) =>
    typeof h?.command === 'string' &&
    h.command.includes('sync-claude-commands.js');
  const kept = groups
    .map((group) => ({
      ...group,
      hooks: (group?.hooks ?? []).filter((h) => !isFrameworkHook(h)),
    }))
    .filter((group) => (group.hooks ?? []).length > 0);
  if (kept.length === groups.length) {
    return { kind: 'skipped', target: rel, detail: 'sync hook absent' };
  }
  if (kept.length === 0) {
    delete settings.hooks.UserPromptSubmit;
  } else {
    settings.hooks.UserPromptSubmit = kept;
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  if (Object.keys(settings).length === 0) {
    fsImpl.rmSync(target, { force: true });
    return {
      kind: 'reverted',
      target: rel,
      detail: 'removed install-created settings.json',
    };
  }
  fsImpl.writeFileSync(
    target,
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );
  return {
    kind: 'reverted',
    target: rel,
    detail: 'removed UserPromptSubmit sync hook',
  };
}

/**
 * Remove the generated `.claude/commands/` slash-command surface. The whole
 * directory is generated from `.agents/workflows/`, so it is safe to remove
 * wholesale (it is gitignored and never hand-edited).
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertClaudeCommands(projectRoot, fsImpl) {
  const target = path.join(projectRoot, '.claude', 'commands');
  const rel = '.claude/commands';
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'directory absent' };
  }
  fsImpl.rmSync(target, { recursive: true, force: true });
  return {
    kind: 'reverted',
    target: rel,
    detail: 'removed generated slash-command surface',
  };
}

/**
 * Remove the two `.gitignore` blocks the install appended (the
 * `.claude/commands/` and `.mcp.json` entries), preserving every other line
 * the operator authored. When the file is left empty it is removed.
 *
 * The `.mcp.json` ignore block is intentionally retained when a real
 * `.mcp.json` exists at the project root: that file may carry secrets and
 * removing the ignore entry would expose it on the next `git add .`.
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertGitignore(projectRoot, fsImpl) {
  const target = path.join(projectRoot, '.gitignore');
  const rel = '.gitignore';
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'file absent' };
  }
  const original = fsImpl.readFileSync(target, 'utf8');
  const mcpJsonExists = fsImpl.existsSync(path.join(projectRoot, '.mcp.json'));
  let next = original;
  for (const [key, def] of Object.entries(GITIGNORE_BLOCKS)) {
    if (next.includes(def.block)) {
      // Retain the .mcp.json ignore entry when a real .mcp.json is present —
      // removing it would expose a potentially secret-bearing file to git.
      if (key === 'mcp' && mcpJsonExists) {
        continue;
      }
      next = next.replace(def.block, '');
    }
  }
  if (next === original) {
    return { kind: 'skipped', target: rel, detail: 'ignore entries absent' };
  }
  next = next.replace(/\n{3,}/g, '\n\n');
  if (next.trim().length === 0) {
    fsImpl.rmSync(target, { force: true });
    return {
      kind: 'reverted',
      target: rel,
      detail: 'removed install-created .gitignore',
    };
  }
  fsImpl.writeFileSync(target, next, 'utf8');
  const detail = mcpJsonExists
    ? 'removed framework ignore entries; kept .mcp.json entry (.mcp.json exists)'
    : 'removed framework ignore entries';
  return { kind: 'reverted', target: rel, detail };
}

/**
 * Remove the framework-seeded npm scripts (and the appended `prepare`
 * fragment) from `package.json`, leaving every operator-authored script and
 * field intact. A script whose value the operator overwrote is preserved.
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertPackageJson(projectRoot, fsImpl) {
  const target = path.join(projectRoot, 'package.json');
  const rel = 'package.json';
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'file absent' };
  }
  const pkg = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  if (!pkg.scripts || typeof pkg.scripts !== 'object') {
    return { kind: 'skipped', target: rel, detail: 'no framework scripts' };
  }
  const removed = [];
  for (const [name, cmd] of Object.entries(FRAMEWORK_NPM_SCRIPTS)) {
    if (pkg.scripts[name] === cmd) {
      delete pkg.scripts[name];
      removed.push(name);
    }
  }
  // `prepare` may be the bare sync command (delete it) or an operator command
  // with the sync fragment appended via ` && ` (strip just the fragment).
  const prepare = pkg.scripts.prepare;
  if (typeof prepare === 'string' && prepare.includes(SYNC_COMMAND)) {
    if (prepare === SYNC_COMMAND) {
      delete pkg.scripts.prepare;
    } else {
      pkg.scripts.prepare = prepare
        .replace(` && ${SYNC_COMMAND}`, '')
        .replace(`${SYNC_COMMAND} && `, '')
        .trim();
    }
    removed.push('prepare');
  }
  if (removed.length === 0) {
    return { kind: 'skipped', target: rel, detail: 'no framework scripts' };
  }
  if (Object.keys(pkg.scripts).length === 0) {
    delete pkg.scripts;
  }
  fsImpl.writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return {
    kind: 'reverted',
    target: rel,
    detail: `removed npm scripts: ${removed.sort().join(', ')}`,
  };
}

/**
 * Reverse the `.husky/pre-commit` quality hook. The file is removed only when
 * it is byte-identical to the install-authored template (`DOWNSTREAM_PRE_COMMIT`).
 * Any other hook — including one whose only non-framework lines are a shebang
 * or comments — is preserved with just the quality-preview line stripped.
 *
 * Using a byte-equality check rather than a "non-`#` meaningful lines"
 * heuristic prevents data loss when an operator's pre-install hook consists
 * entirely of a shebang line and/or comments (all lines start with `#`).
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertPreCommitHook(projectRoot, fsImpl) {
  const target = path.join(projectRoot, '.husky', 'pre-commit');
  const rel = '.husky/pre-commit';
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'hook absent' };
  }
  const original = fsImpl.readFileSync(target, 'utf8');
  if (!original.includes(PRE_COMMIT_MARKER)) {
    return { kind: 'skipped', target: rel, detail: 'quality line absent' };
  }
  // Delete only when the file is exactly the install-authored template — i.e.
  // the install created it from nothing. Operator-authored content (even an
  // all-comments hook) must survive.
  if (original.trim() === DOWNSTREAM_PRE_COMMIT.trim()) {
    fsImpl.rmSync(target, { force: true });
    return {
      kind: 'reverted',
      target: rel,
      detail: 'removed install-created pre-commit hook',
    };
  }
  const kept = original
    .split('\n')
    .filter((line) => !line.includes(PRE_COMMIT_MARKER));
  const remaining = kept.join('\n').trim();
  fsImpl.writeFileSync(target, `${remaining}\n`, 'utf8');
  return {
    kind: 'reverted',
    target: rel,
    detail: 'stripped quality-preview line',
  };
}

// ---------------------------------------------------------------------------
// Dispatch table — ledger target → reversal helper
// ---------------------------------------------------------------------------

/**
 * Map a reversible ledger entry's `target` to the helper that undoes it.
 * Targets that map to the same file (e.g. both `repo-config` and
 * `quality-gates` touch `package.json`) are deduped by the caller so each
 * file is reverted once.
 *
 * @type {Readonly<Record<string, (root: string, fsImpl: typeof fs) => ReversalOutcome>>}
 */
const REVERSAL_BY_TARGET = Object.freeze({
  'CLAUDE.md': revertClaudeMd,
  '.claude/settings.json': revertClaudeSettings,
  '.claude/commands': revertClaudeCommands,
  '.gitignore': revertGitignore,
  'package.json': revertPackageJson,
  '.husky/pre-commit': revertPreCommitHook,
});

// ---------------------------------------------------------------------------
// Planner (pure over the ledger; effects deferred to the helpers)
// ---------------------------------------------------------------------------

/**
 * Partition a ledger's entries into the reversible local-file reversals to
 * run, the remote (`github-admin`) entries to surface as manual follow-ups,
 * and the set of unique file targets to revert (deduped).
 *
 * Pure — derives entirely from the ledger record, with no filesystem access.
 *
 * @param {{ entries: import('../../.agents/scripts/lib/bootstrap/manifest.js').MutationManifestEntry[] }} ledger
 * @returns {{ fileTargets: string[], manual: import('../../.agents/scripts/lib/bootstrap/manifest.js').MutationManifestEntry[] }}
 */
export function planUninstall(ledger) {
  const fileTargets = [];
  const seen = new Set();
  const manual = [];
  for (const entry of ledger.entries ?? []) {
    if (entry.reversible === false) {
      manual.push(entry);
      continue;
    }
    if (!REVERSAL_BY_TARGET[entry.target]) {
      // A reversible entry with no known handler is surfaced as manual so the
      // operator is never silently left with an un-reverted mutation.
      manual.push(entry);
      continue;
    }
    if (!seen.has(entry.target)) {
      seen.add(entry.target);
      fileTargets.push(entry.target);
    }
  }
  return { fileTargets, manual };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const TARGET_COL = 22;

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * @param {ReversalOutcome} outcome
 * @returns {string}
 */
function formatOutcome(outcome) {
  const icon =
    outcome.kind === 'reverted' ? '✔' : outcome.kind === 'manual' ? '!' : '•';
  const label =
    outcome.kind === 'reverted'
      ? 'reverted'
      : outcome.kind === 'manual'
        ? 'manual  '
        : 'skipped ';
  return `${icon}  ${label} ${pad(outcome.target, TARGET_COL)}  ${outcome.detail}\n`;
}

// ---------------------------------------------------------------------------
// Runner (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Execute the uninstall against a project root.
 *
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   fsImpl?: typeof fs,
 *   write?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   includeGithub?: boolean,
 * }} [opts]
 * @returns {{ revertedCount: number, manualCount: number, ledgerFound: boolean }}
 */
export function runUninstall({
  projectRoot,
  cwd,
  fsImpl = fs,
  write = (s) => process.stdout.write(s),
  exit = (code) => process.exit(code),
  includeGithub = false,
} = {}) {
  const root = projectRoot ?? resolveProjectRoot(cwd);

  let ledger;
  try {
    ledger = readInstallLedger(root);
  } catch (err) {
    write(`❌  Install ledger is unreadable: ${err.message}\n`);
    exit(1);
    return { revertedCount: 0, manualCount: 0, ledgerFound: false };
  }

  if (!ledger) {
    write('❌  No install ledger found — nothing to uninstall.\n');
    // A missing ledger is a benign no-op (never installed, or already
    // uninstalled), so this is success, not an error.
    exit(0);
    return { revertedCount: 0, manualCount: 0, ledgerFound: false };
  }

  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    write(
      `❌  Install ledger schema v${ledger.schemaVersion} is not supported by this mandrel (expected v${LEDGER_SCHEMA_VERSION}). Upgrade/downgrade mandrel to match, then re-run.\n`,
    );
    exit(1);
    return { revertedCount: 0, manualCount: 0, ledgerFound: true };
  }

  const { fileTargets, manual } = planUninstall(ledger);

  let revertedCount = 0;
  for (const target of fileTargets) {
    const outcome = REVERSAL_BY_TARGET[target](root, fsImpl);
    if (outcome.kind === 'reverted') revertedCount += 1;
    write(formatOutcome(outcome));
  }

  // GitHub-admin (and any unhandled reversible) entries are manual follow-ups.
  // They are NEVER acted on automatically; --include-github only annotates
  // that the operator acknowledged them (remote reversal stays out of scope).
  let manualCount = 0;
  for (const entry of manual) {
    manualCount += 1;
    const note = includeGithub
      ? `${entry.detail} (acknowledged — reverse manually via the GitHub UI/API)`
      : `${entry.detail} (left untouched — pass --include-github to acknowledge)`;
    write(
      formatOutcome({ kind: 'manual', target: entry.target, detail: note }),
    );
  }

  // Remove the ledger last so a re-run is a clean no-op and a partial failure
  // mid-reversal still leaves the ledger for a resume.
  const lp = ledgerPath(root);
  if (fsImpl.existsSync(lp)) {
    fsImpl.rmSync(lp, { force: true });
    write(
      formatOutcome({
        kind: 'reverted',
        target: '.agents/.install-manifest.json',
        detail: 'removed install ledger',
      }),
    );
    revertedCount += 1;
  }

  write(
    `✅  Uninstalled (${revertedCount} reversed, ${manualCount} manual follow-up${
      manualCount === 1 ? '' : 's'
    })\n`,
  );
  exit(0);
  return { revertedCount, manualCount, ledgerFound: true };
}

// ---------------------------------------------------------------------------
// Subcommand entry point (called by bin/mandrel.js)
// ---------------------------------------------------------------------------

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} argv — supports the single `--include-github` flag.
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  const includeGithub = argv.includes('--include-github');
  runUninstall({ includeGithub });
}

// Re-export so tests and callers can reference the resolved module path
// without re-deriving it.
export const __filenameForTests = fileURLToPath(import.meta.url);
