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

/**
 * Strip the system-prompt import block from `CLAUDE.md`. The file is deleted
 * only when byte-identical to the install template — a heading-only heuristic
 * would delete an operator's all-headings file.
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
  if (original.trim() === SYSTEM_PROMPT_CLAUDE_MD.trim()) {
    fsImpl.rmSync(target, { force: true });
    return {
      kind: 'reverted',
      target: rel,
      detail: 'removed install-created CLAUDE.md',
    };
  }
  // Full block first, then the bare import line for a hand-edited block.
  let next = original.includes(SYSTEM_PROMPT_BLOCK)
    ? original.replace(SYSTEM_PROMPT_BLOCK, '')
    : original;
  if (next.includes(SYSTEM_PROMPT_IMPORT)) {
    next = next
      .split('\n')
      .filter((line) => line.trim() !== SYSTEM_PROMPT_IMPORT)
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
  const groups = settings?.hooks?.UserPromptSubmit;
  const isFrameworkHook = (h) =>
    typeof h?.command === 'string' &&
    h.command.includes('sync-claude-commands.js');

  let mutated = false;

  if (
    settings.enabledPlugins &&
    settings.enabledPlugins['mandrel@mandrel'] !== undefined
  ) {
    delete settings.enabledPlugins['mandrel@mandrel'];
    if (Object.keys(settings.enabledPlugins).length === 0) {
      delete settings.enabledPlugins;
    }
    mutated = true;
  }
  if (settings.extraKnownMarketplaces?.mandrel !== undefined) {
    delete settings.extraKnownMarketplaces.mandrel;
    if (Object.keys(settings.extraKnownMarketplaces).length === 0) {
      delete settings.extraKnownMarketplaces;
    }
    mutated = true;
  }

  if (Array.isArray(groups)) {
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: (group?.hooks ?? []).filter((h) => !isFrameworkHook(h)),
      }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (kept.length !== groups.length) {
      if (kept.length === 0) {
        delete settings.hooks.UserPromptSubmit;
      } else {
        settings.hooks.UserPromptSubmit = kept;
      }
      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
      mutated = true;
    }
  }

  if (!mutated) {
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
  const removed = [];
  for (const [name, cmd] of Object.entries(FRAMEWORK_NPM_SCRIPTS)) {
    if (pkg.scripts[name] === cmd) {
      delete pkg.scripts[name];
      removed.push(name);
    }
  }
  // `prepare` is either the bare sync command or an operator command with it
  // appended via ` && `; strip just the fragment, never write `""`.
  const prepare = pkg.scripts.prepare;
  if (typeof prepare === 'string' && prepare.includes(SYNC_COMMAND)) {
    if (prepare === SYNC_COMMAND) {
      delete pkg.scripts.prepare;
      removed.push('prepare');
    } else {
      const stripped = prepare
        .replace(` && ${SYNC_COMMAND}`, '')
        .replace(`${SYNC_COMMAND} && `, '')
        .trim();
      if (stripped !== prepare) {
        if (stripped === '') {
          delete pkg.scripts.prepare;
        } else {
          pkg.scripts.prepare = stripped;
        }
        removed.push('prepare');
      }
    }
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

  let ledger;
  try {
    ledger = readInstallLedger(root);
  } catch (err) {
    write(`❌  Install ledger is unreadable: ${err.message}\n`);
    exit(1);
    return {
      revertedCount: 0,
      manualCount: 0,
      ledgerFound: false,
      parseErrorCount: 0,
    };
  }

  if (!ledger) {
    write('❌  No install ledger found — nothing to uninstall.\n');
    // Never installed or already uninstalled: a benign no-op.
    exit(0);
    return {
      revertedCount: 0,
      manualCount: 0,
      ledgerFound: false,
      parseErrorCount: 0,
    };
  }

  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    write(
      `❌  Install ledger schema v${ledger.schemaVersion} is not supported by this mandrel (expected v${LEDGER_SCHEMA_VERSION}). Upgrade/downgrade mandrel to match, then re-run.\n`,
    );
    exit(1);
    return {
      revertedCount: 0,
      manualCount: 0,
      ledgerFound: true,
      parseErrorCount: 0,
    };
  }

  const { fileTargets, manual, executedActionByTarget } = planUninstall(ledger);

  if (dryRun) {
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
    for (const entry of manual) {
      const note = includeGithub
        ? `${entry.detail} (acknowledged — reverse manually via the GitHub UI/API)`
        : `${entry.detail} (left untouched — pass --include-github to acknowledge)`;
      write(
        formatOutcome({ kind: 'manual', target: entry.target, detail: note }),
      );
    }
    write(
      `Dry run: ${fileTargets.length} file target(s) would be reverted, ` +
        `${manual.length} manual follow-up(s).\n`,
    );
    exit(0);
    return {
      revertedCount: 0,
      manualCount: manual.length,
      ledgerFound: true,
      parseErrorCount: 0,
    };
  }

  let revertedCount = 0;
  let parseErrorCount = 0;
  for (const target of fileTargets) {
    let outcome;
    try {
      outcome = REVERSAL_BY_TARGET[target](
        root,
        fsImpl,
        executedActionByTarget[target],
      );
    } catch (err) {
      // One corrupt operator file must not abort a half-done uninstall;
      // report it and keep the ledger so a re-run can resume.
      outcome = {
        kind: 'skipped',
        target,
        detail: `unparseable — revert manually (${err.message})`,
      };
      parseErrorCount += 1;
    }
    if (outcome.kind === 'reverted') revertedCount += 1;
    write(formatOutcome(outcome));
  }

  // Never acted on automatically; --include-github only acknowledges them.
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

  // Ledger goes last, and stays when any target failed, so a re-run resumes.
  const lp = ledgerPath(root);
  if (fsImpl.existsSync(lp) && parseErrorCount === 0) {
    fsImpl.rmSync(lp, { force: true });
    write(
      formatOutcome({
        kind: 'reverted',
        target: '.agents/.install-manifest.json',
        detail: 'removed install ledger',
      }),
    );
    revertedCount += 1;
  } else if (parseErrorCount > 0 && fsImpl.existsSync(lp)) {
    write(
      formatOutcome({
        kind: 'skipped',
        target: '.agents/.install-manifest.json',
        detail: 'ledger retained — re-run after fixing unparseable file(s)',
      }),
    );
  }

  write(
    `✅  Uninstalled (${revertedCount} reversed, ${manualCount} manual follow-up${
      manualCount === 1 ? '' : 's'
    })\n`,
  );
  exit(0);
  return { revertedCount, manualCount, ledgerFound: true, parseErrorCount };
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
