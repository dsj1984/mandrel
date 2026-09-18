/**
 * Deterministic project bootstrap steps. Every step is idempotent and
 * additive: a re-run on a bootstrapped clone mutates nothing and does no
 * network I/O.
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCommandExcluded } from '../command-header.js';
import { detectPackageManager as detectPm } from '../detect-package-manager.js';
import { LEDGER_RELATIVE_PATH } from './install-ledger.js';
import { ensureIssueForms } from './issue-forms-template.js';
import { PHASE_GROUPS } from './manifest.js';
import { applyQualityBootstrap } from './quality-bootstrap.js';

export const SYNC_COMMAND = 'node .agents/scripts/sync-claude-commands.js';

// The agent projection runs everywhere the command projection does.
export const SYNC_AGENTS_COMMAND = 'node .agents/scripts/sync-claude-agents.js';

export const BOOTSTRAP_COMMAND = 'node .agents/scripts/bootstrap.js';

/** `CLAUDE.md` wiring keys idempotence off this exact import path. */
export const SYSTEM_PROMPT_IMPORT = '@.agents/instructions.md';

export const SYSTEM_PROMPT_BLOCK = `## System Prompt

${SYSTEM_PROMPT_IMPORT}
`;

export const SYSTEM_PROMPT_CLAUDE_MD = `# Agent Protocols

${SYSTEM_PROMPT_BLOCK}`;

export const GITIGNORE_BLOCKS = Object.freeze({
  commands: {
    pattern: /^\s*\.claude\/commands\/?\s*$/m,
    block:
      '\n# Claude Code command projection is generated from .agents/workflows/ — do not commit.\n.claude/commands/\n',
  },
  mcp: {
    pattern: /^\s*\.mcp\.json\s*$/m,
    block:
      '\n# Project-scoped MCP config carries secrets — keep out of git.\n.mcp.json\n',
  },
  // Matches bare `.env` but NOT the committed `.env.example` placeholder.
  env: {
    pattern: /^\s*\.env\/?\s*$/m,
    block:
      '\n# Secrets live in .env (e.g. GITHUB_TOKEN) — never commit it. Only .env.example (placeholders) is checked in.\n.env\n',
  },
  installLedger: {
    pattern: new RegExp(
      `^\\s*${LEDGER_RELATIVE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm',
    ),
    block: `\n# Per-clone install record written by bootstrap — not a source artifact.\n${LEDGER_RELATIVE_PATH}\n`,
  },
});

/**
 * @param {string} p
 * @param {typeof fs} [fsImpl]
 * @returns {object|null}
 */
function readJsonIfExists(p, fsImpl = fs) {
  if (!fsImpl.existsSync(p)) return null;
  return JSON.parse(fsImpl.readFileSync(p, 'utf8'));
}

/**
 * @param {string} p
 * @param {object} obj
 * @param {typeof fs} [fsImpl]
 */
function writeJson(p, obj, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(p), { recursive: true });
  fsImpl.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * Node floor SSOT (`node:sqlite` stabilised at 22.22.1); import it, never
 * duplicate. Matches `package.json` `engines.node` (`>=22.22.1 <25`).
 */
export const REQUIRED_NODE_FLOOR = '22.22.1';
export const REQUIRED_NODE_CEILING_MAJOR = 25;

/**
 * @param {string} version
 * @returns {boolean}
 */
export function satisfiesNodeEngine(version) {
  const [majorRaw, minorRaw, patchRaw] = version.split('.');
  const major = Number.parseInt(majorRaw, 10) || 0;
  const minor = Number.parseInt(minorRaw, 10) || 0;
  const patch = Number.parseInt(patchRaw, 10) || 0;
  if (major >= REQUIRED_NODE_CEILING_MAJOR) return false;
  if (major > 22) return true;
  if (major < 22) return false;
  if (minor > 22) return true;
  if (minor < 22) return false;
  return patch >= 1;
}

/**
 * @param {string} [version=process.versions.node]
 */
export function checkNodeVersion(version = process.versions.node) {
  return {
    ok: satisfiesNodeEngine(version),
    version,
    required: REQUIRED_NODE_FLOOR,
  };
}

/**
 * Lockfile-based; defaults to `npm`.
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {'pnpm'|'yarn'|'npm'}
 */
export function detectPackageManager(projectRoot, fsImpl = fs) {
  return detectPm(projectRoot, (p) => fsImpl.existsSync(p)) ?? 'npm';
}

/**
 * Ensure `package.json` carries the sync/prepare/bootstrap scripts. Never
 * touches `dependencies` — framework deps arrive transitively via `mandrel`.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 */
export function ensurePackageJson(ctx) {
  const { fsImpl = fs } = ctx;
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  const projectName = path.basename(path.resolve(ctx.projectRoot));
  const outcomes = {
    created: false,
    scriptsSyncCommands: 'already-present',
    scriptsSyncAgents: 'already-present',
    scriptsPrepare: 'already-present',
    scriptsBootstrap: 'already-present',
  };
  let pkg = readJsonIfExists(pkgPath, fsImpl);
  if (!pkg) {
    pkg = {
      name: projectName,
      version: '0.0.0',
      private: true,
      type: 'module',
    };
    outcomes.created = true;
  }
  pkg.scripts = pkg.scripts ?? {};
  if (!pkg.scripts['sync:commands']) {
    pkg.scripts['sync:commands'] = SYNC_COMMAND;
    outcomes.scriptsSyncCommands = 'added';
  }
  if (!pkg.scripts['sync:agents']) {
    pkg.scripts['sync:agents'] = SYNC_AGENTS_COMMAND;
    outcomes.scriptsSyncAgents = 'added';
  }
  const prepare = pkg.scripts.prepare;
  if (!prepare) {
    pkg.scripts.prepare = `${SYNC_COMMAND} && ${SYNC_AGENTS_COMMAND}`;
    outcomes.scriptsPrepare = 'added';
  } else {
    // Append each projection independently so a partial prepare gains the other.
    let next = prepare;
    if (!next.includes('sync-claude-commands.js')) {
      next = `${next} && ${SYNC_COMMAND}`;
    }
    if (!next.includes('sync-claude-agents.js')) {
      next = `${next} && ${SYNC_AGENTS_COMMAND}`;
    }
    if (next !== prepare) {
      pkg.scripts.prepare = next;
      outcomes.scriptsPrepare = 'appended';
    }
  }
  // An operator-defined `bootstrap` script always wins.
  if (!pkg.scripts.bootstrap) {
    pkg.scripts.bootstrap = BOOTSTRAP_COMMAND;
    outcomes.scriptsBootstrap = 'added';
  }
  const mutated =
    outcomes.created ||
    outcomes.scriptsSyncCommands === 'added' ||
    outcomes.scriptsSyncAgents === 'added' ||
    outcomes.scriptsPrepare !== 'already-present' ||
    outcomes.scriptsBootstrap === 'added';
  if (mutated) writeJson(pkgPath, pkg, fsImpl);
  return { ...outcomes, path: pkgPath, mutated };
}

/**
 * Install dependencies when the sentinel module (`ajv`) is unresolvable.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 * @param {typeof defaultSpawnSync} [ctx.spawnImpl]
 */
export function ensureDependenciesInstalled(ctx) {
  const { fsImpl = fs, spawnImpl = defaultSpawnSync } = ctx;
  const manager = detectPackageManager(ctx.projectRoot, fsImpl);
  const sentinel = path.join(
    ctx.projectRoot,
    'node_modules',
    'ajv',
    'package.json',
  );
  const needsInstall = !fsImpl.existsSync(sentinel);
  if (!needsInstall) {
    return { ran: false, manager, skipped: true, reason: 'already-installed' };
  }
  if (ctx.skipInstall) {
    return { ran: false, manager, skipped: true, reason: 'skip-install-flag' };
  }
  const result = spawnImpl(manager, ['install'], {
    cwd: ctx.projectRoot,
    stdio: ctx.quiet ? 'ignore' : 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `[Bootstrap] ${manager} install failed (exit ${result.status}). Resolve the install error and re-run.`,
    );
  }
  return { ran: true, manager, skipped: false };
}

/**
 * Seed a missing `.agentrc.json` from `starter-agentrc.json` with identity
 * placeholders filled. Never overwrites an existing file.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 * @returns {{ action: string, path: string, source?: string }}
 */
export function ensureAgentrc(ctx) {
  const { fsImpl = fs } = ctx;
  const target = path.join(ctx.projectRoot, '.agentrc.json');
  if (fsImpl.existsSync(target)) {
    return { action: 'already-present', path: target };
  }
  const starter = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'starter-agentrc.json',
  );
  if (!fsImpl.existsSync(starter)) {
    return { action: 'missing-starter', path: target };
  }
  let body = fsImpl.readFileSync(starter, 'utf8');
  body = body
    .replace(/\[OWNER\]/g, ctx.answers.owner)
    .replace(/\[REPO\]/g, ctx.answers.repo)
    .replace(/\[USERNAME\]/g, ctx.answers.operatorHandle ?? ctx.answers.owner);
  // The starter pins baseBranch to "main".
  if (ctx.answers.baseBranch && ctx.answers.baseBranch !== 'main') {
    body = body.replace(
      /"baseBranch":\s*"main"/,
      `"baseBranch": "${ctx.answers.baseBranch}"`,
    );
  }
  fsImpl.writeFileSync(target, body, 'utf8');
  return { action: 'seeded', path: target, source: 'starter' };
}

/**
 * Validate `.agentrc.json` against the AJV schema; the caller decides whether to abort.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 */
export async function validateAgentrc(ctx) {
  const { fsImpl = fs } = ctx;
  const schemaModule = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'scripts',
    'lib',
    'config-settings-schema.js',
  );
  if (!fsImpl.existsSync(schemaModule)) {
    return { ok: false, errors: ['config-settings-schema.js not found'] };
  }
  // pathToFileURL handles Windows drive letters and percent-encoding.
  const mod = await import(pathToFileURL(schemaModule).href);
  const validate = mod.getAgentrcValidator();
  const data = readJsonIfExists(
    path.join(ctx.projectRoot, '.agentrc.json'),
    fsImpl,
  );
  if (!data) return { ok: false, errors: ['.agentrc.json missing'] };
  const ok = validate(data);
  return { ok: !!ok, errors: ok ? [] : (validate.errors ?? []) };
}

/**
 * Append each missing {@link GITIGNORE_BLOCKS} entry, keyed off its presence pattern.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 */
export function ensureGitignore(ctx) {
  const { fsImpl = fs } = ctx;
  const target = path.join(ctx.projectRoot, '.gitignore');
  const existing = fsImpl.existsSync(target)
    ? fsImpl.readFileSync(target, 'utf8')
    : '';
  let body = existing;
  const outcomes = {};
  for (const [key, def] of Object.entries(GITIGNORE_BLOCKS)) {
    if (def.pattern.test(body)) {
      outcomes[key] = 'already-present';
      continue;
    }
    body =
      (body.length > 0 && !body.endsWith('\n') ? `${body}\n` : body) +
      def.block;
    outcomes[key] = 'added';
  }
  if (body !== existing) fsImpl.writeFileSync(target, body, 'utf8');
  return { ...outcomes, path: target };
}

/**
 * Materialize the generated Issue Forms; returns per-form actions keyed by ticket type.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 */
function ensureIssueFormsPhase(ctx) {
  const { forms } = ensureIssueForms({ projectRoot: ctx.projectRoot });
  const outcomes = {};
  for (const form of forms) {
    outcomes[form.type] = { action: form.action, path: form.path };
  }
  return outcomes;
}

/**
 * Run the command and agent projections; the sync itself enforces parity.
 *
 * @param {object} ctx
 * @param {typeof defaultSpawnSync} [ctx.spawnImpl]
 */
export function runSyncCommands(ctx) {
  const { spawnImpl = defaultSpawnSync } = ctx;
  const scriptsDir = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'scripts',
  );
  const projections = [
    { label: 'sync-claude-commands.js', script: 'sync-claude-commands.js' },
    { label: 'sync-claude-agents.js', script: 'sync-claude-agents.js' },
  ];
  const stdouts = [];
  for (const { label, script } of projections) {
    const result = spawnImpl(
      process.execPath,
      [path.join(scriptsDir, script)],
      {
        cwd: ctx.projectRoot,
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `[Bootstrap] ${label} failed (exit ${result.status}): ${(
          result.stderr ?? ''
        )
          .trim()
          .slice(0, 400)}`,
      );
    }
    stdouts.push((result.stdout ?? '').trim());
  }
  return { ok: true, stdout: stdouts.filter(Boolean).join('\n') };
}

/**
 * Verify `.claude/commands/*.md` matches the projectable workflows. Shares
 * `isCommandExcluded` with the sync so `command: false` workflows never drift.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 */
export function checkParity(ctx) {
  const { fsImpl = fs } = ctx;
  const workflowsDir = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'workflows',
  );
  const commandsDir = path.join(ctx.projectRoot, '.claude', 'commands');
  const list = (dir) =>
    fsImpl.existsSync(dir)
      ? fsImpl
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => e.name.replace(/\.md$/, ''))
          .sort()
      : [];
  const projectable = (name) =>
    !isCommandExcluded(
      fsImpl.readFileSync(path.join(workflowsDir, `${name}.md`), 'utf8'),
    );
  const workflows = new Set(list(workflowsDir).filter(projectable));
  const commands = new Set(list(commandsDir));
  const missingCommand = [...workflows].filter((n) => !commands.has(n));
  const orphanCommand = [...commands].filter((n) => !workflows.has(n));
  return {
    ok: missingCommand.length === 0 && orphanCommand.length === 0,
    missingCommand,
    orphanCommand,
  };
}

/**
 * Ensure `CLAUDE.md` imports the system prompt — without it the framework
 * never loads on cold start. Creates, appends, or no-ops.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 */
export function ensureSystemPromptWiring(ctx) {
  const { fsImpl = fs } = ctx;
  const target = path.join(ctx.projectRoot, 'CLAUDE.md');
  if (!fsImpl.existsSync(target)) {
    fsImpl.writeFileSync(target, SYSTEM_PROMPT_CLAUDE_MD, 'utf8');
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
 * Windows git-perf hints, warn-only; never mutates global git config.
 *
 * @param {object} ctx
 * @param {typeof fs} [ctx.fsImpl]
 * @param {typeof defaultSpawnSync} [ctx.spawnImpl]
 */
export function checkWindowsGitPerf(ctx) {
  const { fsImpl = fs, spawnImpl = defaultSpawnSync } = ctx;
  if (os.platform() !== 'win32') {
    return { platform: process.platform, skipped: true };
  }
  const script = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'scripts',
    'check-windows-git-perf.js',
  );
  if (!fsImpl.existsSync(script)) {
    return { platform: 'win32', skipped: true, reason: 'script-missing' };
  }
  const result = spawnImpl(process.execPath, [script], {
    cwd: ctx.projectRoot,
    encoding: 'utf8',
  });
  return {
    platform: 'win32',
    skipped: false,
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
  };
}

/**
 * @typedef {object} BootstrapPhase
 * @property {string} name       — report key.
 * @property {(ctx: object, report: object) => any|Promise<any>} run
 *                                 — may read prior phases via `report.<name>`.
 * @property {boolean} [isFatal]  — throw when `formatError` returns a message.
 * @property {(result: any) => string|null} [formatError]
 */

const fatalNodeCheck = (result) =>
  result.ok
    ? null
    : `[Bootstrap] Node ${result.version} is below required ${result.required}. Upgrade Node and re-run.`;

const fatalValidation = (result) =>
  result.ok
    ? null
    : `[Bootstrap] .agentrc.json failed schema validation: ${JSON.stringify(
        result.errors,
        null,
        2,
      )}`;

const fatalParity = (result) =>
  result.ok
    ? null
    : `[Bootstrap] Parity check failed — workflows missing commands: ${
        result.missingCommand.join(', ') || '(none)'
      }; orphan commands: ${result.orphanCommand.join(', ') || '(none)'}`;

/**
 * Ordered bootstrap pipeline. `phaseGroup` is ledger/uninstall metadata only
 * — every phase runs on every install.
 */
export const BOOTSTRAP_PHASES = Object.freeze([
  {
    name: 'nodeCheck',
    run: () => checkNodeVersion(),
    isFatal: true,
    formatError: fatalNodeCheck,
  },
  {
    name: 'pkg',
    phaseGroup: PHASE_GROUPS.REPO_CONFIG,
    run: (ctx) => ensurePackageJson(ctx),
  },
  {
    name: 'install',
    run: (ctx) => ensureDependenciesInstalled(ctx),
  },
  {
    name: 'agentrc',
    phaseGroup: PHASE_GROUPS.REPO_CONFIG,
    run: (ctx) => ensureAgentrc(ctx),
  },
  {
    name: 'validation',
    phaseGroup: PHASE_GROUPS.REPO_CONFIG,
    run: async (ctx) => validateAgentrc(ctx),
    isFatal: true,
    formatError: fatalValidation,
  },
  {
    name: 'systemPromptWiring',
    phaseGroup: PHASE_GROUPS.IDE_WIRING,
    run: (ctx) => ensureSystemPromptWiring(ctx),
  },
  {
    name: 'gitignore',
    phaseGroup: PHASE_GROUPS.IDE_WIRING,
    run: (ctx) => ensureGitignore(ctx),
  },
  {
    name: 'issueForms',
    phaseGroup: PHASE_GROUPS.REPO_CONFIG,
    run: (ctx) =>
      ctx.withIssueForms === true
        ? ensureIssueFormsPhase(ctx)
        : { skipped: true, reason: 'issue-forms-not-opted-in' },
  },
  {
    name: 'sync',
    phaseGroup: PHASE_GROUPS.IDE_WIRING,
    run: (ctx) => runSyncCommands(ctx),
  },
  {
    name: 'parity',
    phaseGroup: PHASE_GROUPS.IDE_WIRING,
    run: (ctx) => checkParity(ctx),
    isFatal: true,
    formatError: fatalParity,
  },
  {
    name: 'quality',
    phaseGroup: PHASE_GROUPS.QUALITY_GATES,
    run: (ctx) =>
      ctx.withQuality === true
        ? applyQualityBootstrap({ projectRoot: ctx.projectRoot })
        : { skipped: true, reason: 'quality-not-opted-in' },
  },
  {
    name: 'winPerf',
    run: (ctx) => checkWindowsGitPerf(ctx),
  },
]);

/**
 * @param {BootstrapPhase} phase
 * @param {any} result
 */
export function throwIfFatal(phase, result) {
  if (!phase.isFatal) return;
  const msg = phase.formatError?.(result);
  if (typeof msg === 'string' && msg.length > 0) throw new Error(msg);
}

/**
 * @param {ReadonlyArray<BootstrapPhase>} phases
 * @param {object} ctx
 * @returns {Promise<object>}
 */
export async function runPhases(phases, ctx) {
  const report = {};
  for (const phase of phases) {
    const result = await phase.run(ctx, report);
    report[phase.name] = result;
    throwIfFatal(phase, result);
  }
  return report;
}

/**
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.agentRoot]
 * @param {{ owner: string, repo: string, baseBranch: string,
 *           operatorHandle: string|null }} ctx.answers
 * @param {boolean} [ctx.withQuality]
 * @param {boolean} [ctx.skipGithub]
 * @param {boolean} [ctx.skipInstall]
 * @param {boolean} [ctx.quiet]
 * @param {typeof fs} [ctx.fsImpl]
 * @param {typeof defaultSpawnSync} [ctx.spawnImpl]
 * @returns {Promise<object>}
 */
export async function applyProjectBootstrap(ctx) {
  return runPhases(BOOTSTRAP_PHASES, ctx);
}
