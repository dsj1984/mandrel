// lib/cli/uninstall.js
/**
 * `mandrel uninstall`: reverse the reversible entries of the install ledger
 * (`.agents/.install-manifest.json`). Reversal is marker-based so
 * operator-authored content survives; a file is deleted only when the install
 * created it. `github-admin` entries (`reversible: false`) are only listed as
 * manual follow-ups. Idempotent: the ledger is removed last.
 *
 * @module cli/uninstall
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  LEDGER_SCHEMA_VERSION,
  ledgerPath,
  readInstallLedger,
} from '../../.agents/scripts/lib/bootstrap/install-ledger.js';
import {
  BOOTSTRAP_COMMAND,
  GITIGNORE_BLOCKS,
  LEGACY_PREPARE_COMMAND,
  PREPARE_COMMAND,
  SYNC_COMMAND,
  SYSTEM_PROMPT_AGENTS_MD,
  SYSTEM_PROMPT_BLOCK,
  SYSTEM_PROMPT_IMPORT,
  SYSTEM_PROMPT_READ_DIRECTIVE,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import {
  DOWNSTREAM_PRE_COMMIT,
  PRE_COMMIT_MARKER,
  QUALITY_NPM_SCRIPTS,
} from '../../.agents/scripts/lib/bootstrap/quality-bootstrap.js';

/**
 * @param {() => string} [cwd=process.cwd]
 * @returns {string}
 */
function resolveProjectRoot(cwd = () => process.cwd()) {
  return cwd();
}

/**
 * Scripts the bootstrap seeds; one is removed only while its value still
 * equals the seeded command. `prepare` is handled separately because the
 * sync command may have been appended to an existing value.
 *
 * @type {Readonly<Record<string, string>>}
 */
const FRAMEWORK_NPM_SCRIPTS = Object.freeze({
  'sync:commands': SYNC_COMMAND,
  bootstrap: BOOTSTRAP_COMMAND,
  ...QUALITY_NPM_SCRIPTS,
});

/**
 * @typedef {object} ReversalOutcome
 * @property {'reverted'|'skipped'|'manual'} kind
 * @property {string} target
 * @property {string} detail
 */

/** The block's own lines, stripped one by one from a hand-edited block. */
const FRAMEWORK_PROMPT_LINES = new Set([
  SYSTEM_PROMPT_IMPORT,
  SYSTEM_PROMPT_READ_DIRECTIVE,
]);

/**
 * Strip the system-prompt import block from a root entry doc. The file is
 * deleted only when byte-identical to the install template — a heading-only
 * heuristic would delete an operator's all-headings file.
 *
 * @param {string} rel - `AGENTS.md`, or a legacy un-migrated `CLAUDE.md`.
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertEntryDoc(rel, projectRoot, fsImpl) {
  const target = path.join(projectRoot, rel);
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'file absent' };
  }
  const original = fsImpl.readFileSync(target, 'utf8');
  if (!original.includes(SYSTEM_PROMPT_IMPORT)) {
    return { kind: 'skipped', target: rel, detail: 'import already absent' };
  }
  if (original.trim() === SYSTEM_PROMPT_AGENTS_MD.trim()) {
    fsImpl.rmSync(target, { force: true });
    return {
      kind: 'reverted',
      target: rel,
      detail: `removed install-created ${rel}`,
    };
  }
  // Full block first, then the bare import line for a hand-edited block.
  let next = original.includes(SYSTEM_PROMPT_BLOCK)
    ? original.replace(SYSTEM_PROMPT_BLOCK, '')
    : original;
  if (next.includes(SYSTEM_PROMPT_IMPORT)) {
    next = next
      .split('\n')
      .filter((line) => !FRAMEWORK_PROMPT_LINES.has(line.trim()))
      .join('\n');
  }
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
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertAgentsMd(projectRoot, fsImpl) {
  return revertEntryDoc('AGENTS.md', projectRoot, fsImpl);
}

/**
 * Pre-2.65 ledgers name CLAUDE.md. An un-migrated CLAUDE.md reverts as
 * before; once the update migration folded it away, the wiring lives in
 * AGENTS.md, so that is reverted instead. CLAUDE.md is never recreated.
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertClaudeMd(projectRoot, fsImpl) {
  const legacy = fsImpl.existsSync(path.join(projectRoot, 'CLAUDE.md'));
  return revertEntryDoc(
    legacy ? 'CLAUDE.md' : 'AGENTS.md',
    projectRoot,
    fsImpl,
  );
}

/**
 * Delete `obj[parent][child]`, then `obj[parent]` once it is left empty.
 *
 * @param {Record<string, any>} obj
 * @param {string} parent
 * @param {string} child
 * @returns {boolean} whether the child key was present (and so removed).
 */
function dropNestedKey(obj, parent, child) {
  if (obj[parent]?.[child] === undefined) return false;
  delete obj[parent][child];
  if (Object.keys(obj[parent]).length === 0) delete obj[parent];
  return true;
}

/**
 * @param {unknown} hook
 * @returns {boolean}
 */
function isFrameworkHook(hook) {
  return (
    typeof hook?.command === 'string' &&
    hook.command.includes('sync-claude-commands.js')
  );
}

/**
 * Splice the sync hook out of `settings.hooks.UserPromptSubmit`, dropping
 * emptied groups and an emptied `hooks` object.
 *
 * @param {Record<string, any>} settings
 * @returns {boolean} whether any group was removed.
 */
function stripSyncHook(settings) {
  const groups = settings.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return false;
  const kept = groups
    .map((group) => ({
      ...group,
      hooks: (group?.hooks ?? []).filter((h) => !isFrameworkHook(h)),
    }))
    .filter((group) => group.hooks.length > 0);
  if (kept.length === groups.length) return false;
  if (kept.length > 0) {
    settings.hooks.UserPromptSubmit = kept;
  } else {
    dropNestedKey(settings, 'hooks', 'UserPromptSubmit');
  }
  return true;
}

/**
 * Splice the sync hook and any legacy plugin-enablement keys out of
 * `.claude/settings.json`, keeping everything else; delete the file if empty.
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
  // Every step runs (no short-circuit): each strips its own wiring.
  const mutations = [
    dropNestedKey(settings, 'enabledPlugins', 'mandrel@mandrel'),
    dropNestedKey(settings, 'extraKnownMarketplaces', 'mandrel'),
    stripSyncHook(settings),
  ];
  if (!mutations.includes(true)) {
    return { kind: 'skipped', target: rel, detail: 'framework wiring absent' };
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
    detail: 'removed sync hook (and any legacy plugin enablement)',
  };
}

/**
 * Remove the generated (gitignored, never hand-edited) `.claude/commands/`
 * tree plus any legacy plugin projection.
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {ReversalOutcome}
 */
function revertClaudeCommands(projectRoot, fsImpl) {
  const rel = '.claude/commands';
  const targets = [
    path.join(projectRoot, '.claude', 'commands'),
    path.join(projectRoot, '.claude', 'plugins', 'mandrel'),
    path.join(projectRoot, '.claude', '.claude-plugin'),
  ];
  const present = targets.filter((t) => fsImpl.existsSync(t));
  if (present.length === 0) {
    return {
      kind: 'skipped',
      target: rel,
      detail: 'command projection absent',
    };
  }
  for (const t of present) {
    fsImpl.rmSync(t, { recursive: true, force: true });
  }
  return {
    kind: 'reverted',
    target: rel,
    detail: 'removed generated .claude/commands/ projection',
  };
}

/**
 * Remove the install's `.gitignore` blocks, keeping operator lines. The
 * `.mcp.json` block is kept while a real `.mcp.json` exists — it may carry
 * secrets and would otherwise be exposed to `git add .`.
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

/** Every `prepare` value bootstrap writes whole: guarded, legacy pair, bare sync. */
const BOOTSTRAP_PREPARE_FORMS = new Set([
  PREPARE_COMMAND,
  LEGACY_PREPARE_COMMAND,
  SYNC_COMMAND,
]);

/**
 * Strip the framework part of a `prepare`: a whole bootstrap-written form
 * goes entirely; an operator command with the sync appended via ` && ` loses
 * just that fragment. `next === ''` means delete the key, never write `""`.
 *
 * @param {unknown} prepare
 * @returns {{ changed: boolean, next: string }}
 */
function stripPrepare(prepare) {
  if (typeof prepare !== 'string' || !prepare.includes(SYNC_COMMAND)) {
    return { changed: false, next: '' };
  }
  if (BOOTSTRAP_PREPARE_FORMS.has(prepare)) return { changed: true, next: '' };
  const next = prepare
    .replace(` && ${SYNC_COMMAND}`, '')
    .replace(`${SYNC_COMMAND} && `, '')
    .trim();
  return { changed: next !== prepare, next };
}

/**
 * Remove the seeded framework scripts (and the framework part of `prepare`)
 * from `scripts` in place.
 *
 * @param {Record<string, unknown>} scripts
 * @returns {string[]} the names of the removed (or rewritten) scripts.
 */
function stripFrameworkScripts(scripts) {
  const removed = Object.entries(FRAMEWORK_NPM_SCRIPTS)
    .filter(([name, cmd]) => scripts[name] === cmd)
    .map(([name]) => name);
  for (const name of removed) delete scripts[name];
  const prepare = stripPrepare(scripts.prepare);
  if (!prepare.changed) return removed;
  if (prepare.next === '') {
    delete scripts.prepare;
  } else {
    scripts.prepare = prepare.next;
  }
  return [...removed, 'prepare'];
}

/**
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
  const removed = stripFrameworkScripts(pkg.scripts);
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
 * Delete `.agentrc.json` only when the ledger's `executedAction` is `seeded`
 * (the install wrote it). `already-present`, a missing hint, or anything else
 * fails safe and preserves the operator's file.
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @param {string} [executedAction] — the recorded `agentrc` phase outcome.
 * @returns {ReversalOutcome}
 */
function revertAgentrc(projectRoot, fsImpl, executedAction) {
  const target = path.join(projectRoot, '.agentrc.json');
  const rel = '.agentrc.json';
  if (!fsImpl.existsSync(target)) {
    return { kind: 'skipped', target: rel, detail: 'file absent' };
  }
  if (executedAction !== 'seeded') {
    return {
      kind: 'skipped',
      target: rel,
      detail: 'pre-existing .agentrc.json preserved (not install-created)',
    };
  }
  fsImpl.rmSync(target, { force: true });
  return {
    kind: 'reverted',
    target: rel,
    detail: 'removed install-created .agentrc.json',
  };
}

/**
 * Strip the quality-preview line from `.husky/pre-commit`; delete the file
 * only when byte-identical to the install template (an operator hook of only
 * a shebang and comments must survive).
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

/**
 * Ledger target → reversal helper. Only `revertAgentrc` reads the third
 * `executedAction` argument.
 *
 * @type {Readonly<Record<string, (root: string, fsImpl: typeof fs, executedAction?: string) => ReversalOutcome>>}
 */
const REVERSAL_BY_TARGET = Object.freeze({
  'AGENTS.md': revertAgentsMd,
  'CLAUDE.md': revertClaudeMd,
  '.claude/settings.json': revertClaudeSettings,
  '.claude/plugins/mandrel': revertClaudeCommands,
  '.gitignore': revertGitignore,
  'package.json': revertPackageJson,
  '.agentrc.json': revertAgentrc,
  '.husky/pre-commit': revertPreCommitHook,
});

/**
 * Partition ledger entries into deduped file targets and manual follow-ups.
 * Pure. For a target shared by several entries, the first defined
 * `executedAction` wins (they record the same phase outcome).
 *
 * @param {{ entries: Array<import('../../.agents/scripts/lib/bootstrap/manifest.js').MutationManifestEntry & { executedAction?: string }> }} ledger
 * @returns {{ fileTargets: string[], manual: import('../../.agents/scripts/lib/bootstrap/manifest.js').MutationManifestEntry[], executedActionByTarget: Record<string, string> }}
 */
export function planUninstall(ledger) {
  const fileTargets = [];
  const seen = new Set();
  const manual = [];
  const executedActionByTarget = {};
  for (const entry of ledger.entries ?? []) {
    if (entry.reversible === false) {
      manual.push(entry);
      continue;
    }
    if (!REVERSAL_BY_TARGET[entry.target]) {
      // Never silently leave a mutation un-reverted.
      manual.push(entry);
      continue;
    }
    if (
      typeof entry.executedAction === 'string' &&
      executedActionByTarget[entry.target] === undefined
    ) {
      executedActionByTarget[entry.target] = entry.executedAction;
    }
    if (!seen.has(entry.target)) {
      seen.add(entry.target);
      fileTargets.push(entry.target);
    }
  }
  return { fileTargets, manual, executedActionByTarget };
}

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

/**
 * @param {number} revertedCount
 * @param {number} manualCount
 * @param {boolean} ledgerFound
 * @param {number} parseErrorCount
 * @returns {{ revertedCount: number, manualCount: number, ledgerFound: boolean, parseErrorCount: number }}
 */
function result(revertedCount, manualCount, ledgerFound, parseErrorCount) {
  return { revertedCount, manualCount, ledgerFound, parseErrorCount };
}

/**
 * Read and validate the install ledger. Returns the ledger, or the message
 * and exit code that end the run instead.
 *
 * @param {string} root
 * @returns {{ ledger: object } | { message: string, code: number, ledgerFound: boolean }}
 */
function loadLedger(root) {
  let ledger;
  try {
    ledger = readInstallLedger(root);
  } catch (err) {
    return {
      message: `❌  Install ledger is unreadable: ${err.message}\n`,
      code: 1,
      ledgerFound: false,
    };
  }
  if (!ledger) {
    // Never installed or already uninstalled: a benign no-op.
    return {
      message: '❌  No install ledger found — nothing to uninstall.\n',
      code: 0,
      ledgerFound: false,
    };
  }
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    return {
      message: `❌  Install ledger schema v${ledger.schemaVersion} is not supported by this mandrel (expected v${LEDGER_SCHEMA_VERSION}). Upgrade/downgrade mandrel to match, then re-run.\n`,
      code: 1,
      ledgerFound: true,
    };
  }
  return { ledger };
}

/**
 * Never acted on automatically; --include-github only acknowledges them.
 *
 * @param {{ target: string, detail: string }} entry
 * @param {boolean} includeGithub
 * @returns {string}
 */
function formatManual(entry, includeGithub) {
  const note = includeGithub
    ? `${entry.detail} (acknowledged — reverse manually via the GitHub UI/API)`
    : `${entry.detail} (left untouched — pass --include-github to acknowledge)`;
  return formatOutcome({ kind: 'manual', target: entry.target, detail: note });
}

/**
 * Run one target's reversal. One corrupt operator file must not abort a
 * half-done uninstall: a throw becomes a skipped outcome flagged `failed`.
 *
 * @param {string} target
 * @param {string} root
 * @param {typeof fs} fsImpl
 * @param {string} [executedAction]
 * @returns {{ outcome: ReversalOutcome, failed: boolean }}
 */
function revertTarget(target, root, fsImpl, executedAction) {
  try {
    return {
      outcome: REVERSAL_BY_TARGET[target](root, fsImpl, executedAction),
      failed: false,
    };
  } catch (err) {
    return {
      outcome: {
        kind: 'skipped',
        target,
        detail: `unparseable — revert manually (${err.message})`,
      },
      failed: true,
    };
  }
}

const LEDGER_TARGET = '.agents/.install-manifest.json';

/**
 * The ledger goes last, and stays when any target failed, so a re-run
 * resumes.
 *
 * @param {string} root
 * @param {typeof fs} fsImpl
 * @param {number} parseErrorCount
 * @returns {ReversalOutcome|null} the ledger's outcome, or null when absent.
 */
function retireLedger(root, fsImpl, parseErrorCount) {
  const lp = ledgerPath(root);
  if (!fsImpl.existsSync(lp)) return null;
  if (parseErrorCount > 0) {
    return {
      kind: 'skipped',
      target: LEDGER_TARGET,
      detail: 'ledger retained — re-run after fixing unparseable file(s)',
    };
  }
  fsImpl.rmSync(lp, { force: true });
  return {
    kind: 'reverted',
    target: LEDGER_TARGET,
    detail: 'removed install ledger',
  };
}

/**
 * @param {{ fileTargets: string[], manual: Array<{ target: string, detail: string }> }} plan
 * @param {boolean} includeGithub
 * @param {(s: string) => void} write
 */
function printDryRun({ fileTargets, manual }, includeGithub, write) {
  write('mandrel uninstall — planned reversal (dry run)\n');
  for (const target of fileTargets) {
    write(
      formatOutcome({
        kind: 'reverted',
        target,
        detail: '(would be reverted)',
      }),
    );
  }
  for (const entry of manual) write(formatManual(entry, includeGithub));
  write(
    `Dry run: ${fileTargets.length} file target(s) would be reverted, ` +
      `${manual.length} manual follow-up(s).\n`,
  );
}

/**
 * @param {{ fileTargets: string[], manual: Array<{ target: string, detail: string }>, executedActionByTarget: Record<string, string> }} plan
 * @param {{ root: string, fsImpl: typeof fs, write: (s: string) => void, includeGithub: boolean }} ctx
 * @returns {{ revertedCount: number, manualCount: number, parseErrorCount: number }}
 */
function applyUninstall(plan, { root, fsImpl, write, includeGithub }) {
  let revertedCount = 0;
  let parseErrorCount = 0;
  for (const target of plan.fileTargets) {
    const { outcome, failed } = revertTarget(
      target,
      root,
      fsImpl,
      plan.executedActionByTarget[target],
    );
    if (failed) parseErrorCount += 1;
    if (outcome.kind === 'reverted') revertedCount += 1;
    write(formatOutcome(outcome));
  }
  for (const entry of plan.manual) write(formatManual(entry, includeGithub));
  const ledgerOutcome = retireLedger(root, fsImpl, parseErrorCount);
  if (ledgerOutcome) {
    if (ledgerOutcome.kind === 'reverted') revertedCount += 1;
    write(formatOutcome(ledgerOutcome));
  }
  return { revertedCount, manualCount: plan.manual.length, parseErrorCount };
}

/**
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   fsImpl?: typeof fs,
 *   write?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   includeGithub?: boolean,
 *   dryRun?: boolean,
 * }} [opts]
 * @returns {{ revertedCount: number, manualCount: number, ledgerFound: boolean, parseErrorCount: number }}
 */
export function runUninstall({
  projectRoot,
  cwd,
  fsImpl = fs,
  write = (s) => process.stdout.write(s),
  exit = (code) => process.exit(code),
  includeGithub = false,
  dryRun = false,
} = {}) {
  const root = projectRoot ?? resolveProjectRoot(cwd);

  const loaded = loadLedger(root);
  if (!loaded.ledger) {
    write(loaded.message);
    exit(loaded.code);
    return result(0, 0, loaded.ledgerFound, 0);
  }

  const plan = planUninstall(loaded.ledger);

  if (dryRun) {
    printDryRun(plan, includeGithub, write);
    exit(0);
    return result(0, plan.manual.length, true, 0);
  }

  const { revertedCount, manualCount, parseErrorCount } = applyUninstall(plan, {
    root,
    fsImpl,
    write,
    includeGithub,
  });
  write(
    `✅  Uninstalled (${revertedCount} reversed, ${manualCount} manual follow-up${
      manualCount === 1 ? '' : 's'
    })\n`,
  );
  exit(0);
  return result(revertedCount, manualCount, true, parseErrorCount);
}

/**
 * Flags: `--include-github` (acknowledge GitHub-side follow-ups),
 * `--dry-run`.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  const includeGithub = argv.includes('--include-github');
  const dryRun = argv.includes('--dry-run');
  runUninstall({ includeGithub, dryRun });
}
