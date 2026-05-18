/**
 * bootstrap/project-bootstrap — deterministic port of the
 * `/agents-bootstrap-project` workflow (Story #2074, hard cutover).
 *
 * Each exported `ensure*` function is one step of the bootstrap. Every step
 * is idempotent and additive — re-running on an already-bootstrapped clone
 * produces zero file mutations and zero network I/O.
 *
 * The composite `applyProjectBootstrap(ctx)` runs the steps in order and
 * returns a structured report the CLI summarises at exit.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyQualityBootstrap } from './quality-bootstrap.js';

export const REQUIRED_RUNTIME_DEPS = Object.freeze({
  ajv: '^8.20.0',
  'ajv-formats': '^3.0.1',
  'js-yaml': '^4.1.1',
  picomatch: '^4.0.4',
  'string-argv': '^0.3.2',
  'typhonjs-escomplex': '^0.1.0',
});

export const SYNC_COMMAND = 'node .agents/scripts/sync-claude-commands.js';

const GITIGNORE_BLOCKS = Object.freeze({
  commands: {
    pattern: /^\s*\.claude\/commands\/?\s*$/m,
    block:
      '\n# Claude Code slash commands are generated from .agents/workflows/ — do not commit.\n.claude/commands/\n',
  },
  mcp: {
    pattern: /^\s*\.mcp\.json\s*$/m,
    block:
      '\n# Project-scoped MCP config carries secrets — keep out of git.\n.mcp.json\n',
  },
});

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * Step 1 — Verify Node ≥ 20. Returns `{ ok, version }` so the CLI can
 * report the detected version regardless of whether the check passed.
 */
export function checkNodeVersion() {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0], 10) || 0;
  return { ok: major >= 20, version, required: 20 };
}

/**
 * Detect the package manager based on lockfile presence. Defaults to
 * `npm` when no lock is found.
 */
export function detectPackageManager(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Step 2a/2b/2c — Ensure `package.json` exists and carries the
 * `sync:commands` + `prepare` scripts plus the framework's runtime
 * dependencies. Returns the per-key outcome the caller can render.
 */
export function ensurePackageJson(ctx) {
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  const projectName = path.basename(path.resolve(ctx.projectRoot));
  const outcomes = {
    created: false,
    scriptsSyncCommands: 'already-present',
    scriptsPrepare: 'already-present',
    deps: { added: [], skipped: [] },
  };
  let pkg = readJsonIfExists(pkgPath);
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
  const prepare = pkg.scripts.prepare;
  if (!prepare) {
    pkg.scripts.prepare = SYNC_COMMAND;
    outcomes.scriptsPrepare = 'added';
  } else if (!prepare.includes('sync-claude-commands.js')) {
    pkg.scripts.prepare = `${prepare} && ${SYNC_COMMAND}`;
    outcomes.scriptsPrepare = 'appended';
  }
  pkg.dependencies = pkg.dependencies ?? {};
  for (const [dep, version] of Object.entries(REQUIRED_RUNTIME_DEPS)) {
    if (pkg.dependencies[dep]) {
      outcomes.deps.skipped.push(dep);
      continue;
    }
    pkg.dependencies[dep] = version;
    outcomes.deps.added.push(dep);
  }
  const mutated =
    outcomes.created ||
    outcomes.scriptsSyncCommands === 'added' ||
    outcomes.scriptsPrepare !== 'already-present' ||
    outcomes.deps.added.length > 0;
  if (mutated) writeJson(pkgPath, pkg);
  return { ...outcomes, path: pkgPath, mutated };
}

/**
 * Step 2d — Install dependencies when the package.json was touched or
 * the framework's sentinel module is unresolvable. Returns
 * `{ ran, manager, skipped, reason }`.
 */
export function ensureDependenciesInstalled(ctx, packageOutcome) {
  const manager = detectPackageManager(ctx.projectRoot);
  const sentinel = path.join(
    ctx.projectRoot,
    'node_modules',
    'ajv',
    'package.json',
  );
  const needsInstall =
    packageOutcome.deps.added.length > 0 || !fs.existsSync(sentinel);
  if (!needsInstall) {
    return { ran: false, manager, skipped: true, reason: 'already-installed' };
  }
  if (ctx.skipInstall) {
    return { ran: false, manager, skipped: true, reason: 'skip-install-flag' };
  }
  const result = spawnSync(manager, ['install'], {
    cwd: ctx.projectRoot,
    stdio: ctx.quiet ? 'ignore' : 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `[bootstrap] ${manager} install failed (exit ${result.status}). Resolve the install error and re-run.`,
    );
  }
  return { ran: true, manager, skipped: false };
}

/**
 * Step 2.5a — Seed `.agentrc.json` from the bundled starter when missing.
 * Replaces the `[OWNER]` / `[REPO]` / `[USERNAME]` / `[BASE_BRANCH]`
 * placeholders with operator-supplied values.
 *
 * An existing `.agentrc.json` is never overwritten — operator wins.
 */
export function ensureAgentrc(ctx) {
  const target = path.join(ctx.projectRoot, '.agentrc.json');
  if (fs.existsSync(target)) {
    return { action: 'already-present', path: target };
  }
  const starter = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'starter-agentrc.json',
  );
  if (!fs.existsSync(starter)) {
    return { action: 'missing-starter', path: target };
  }
  let body = fs.readFileSync(starter, 'utf8');
  body = body
    .replace(/\[OWNER\]/g, ctx.answers.owner)
    .replace(/\[REPO\]/g, ctx.answers.repo)
    .replace(/\[USERNAME\]/g, ctx.answers.operatorHandle ?? ctx.answers.owner);
  // The starter pins baseBranch to "main"; if the operator chose a
  // different default, update the seeded copy so the per-clone config
  // matches the live remote HEAD.
  if (ctx.answers.baseBranch && ctx.answers.baseBranch !== 'main') {
    body = body.replace(
      /"baseBranch":\s*"main"/,
      `"baseBranch": "${ctx.answers.baseBranch}"`,
    );
  }
  fs.writeFileSync(target, body, 'utf8');
  return { action: 'seeded', path: target };
}

/**
 * Step 2.5b — Validate `.agentrc.json` against the framework's AJV schema.
 * Returns `{ ok, errors }`. Caller decides whether to abort.
 */
export async function validateAgentrc(ctx) {
  const schemaModule = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'scripts',
    'lib',
    'config-settings-schema.js',
  );
  if (!fs.existsSync(schemaModule)) {
    return { ok: false, errors: ['config-settings-schema.js not found'] };
  }
  const mod = await import(`file://${schemaModule.replace(/\\/g, '/')}`);
  const validate = mod.getAgentrcValidator();
  const data = readJsonIfExists(path.join(ctx.projectRoot, '.agentrc.json'));
  if (!data) return { ok: false, errors: ['.agentrc.json missing'] };
  const ok = validate(data);
  return { ok: !!ok, errors: ok ? [] : (validate.errors ?? []) };
}

/**
 * Step 3 — Merge the `UserPromptSubmit` sync hook into `.claude/settings.json`.
 * Returns `{ action }`.
 */
export function ensureClaudeSettings(ctx) {
  const target = path.join(ctx.projectRoot, '.claude', 'settings.json');
  const hook = { type: 'command', command: SYNC_COMMAND };
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fresh = {
      hooks: {
        UserPromptSubmit: [{ hooks: [hook] }],
      },
    };
    writeJson(target, fresh);
    return { action: 'created', path: target };
  }
  const settings = readJsonIfExists(target);
  settings.hooks = settings.hooks ?? {};
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit ?? [];
  const already = settings.hooks.UserPromptSubmit.some((group) =>
    (group?.hooks ?? []).some(
      (h) =>
        typeof h?.command === 'string' &&
        h.command.includes('sync-claude-commands.js'),
    ),
  );
  if (already) return { action: 'already-present', path: target };
  settings.hooks.UserPromptSubmit.push({ hooks: [hook] });
  writeJson(target, settings);
  return { action: 'merged', path: target };
}

/**
 * Step 4 + Step 8 — Ensure `.gitignore` carries the `.claude/commands/`
 * and `.mcp.json` entries. Returns a per-block outcome.
 */
export function ensureGitignore(ctx) {
  const target = path.join(ctx.projectRoot, '.gitignore');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
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
  if (body !== existing) fs.writeFileSync(target, body, 'utf8');
  return { ...outcomes, path: target };
}

/**
 * Step 5 — Run the sync script. Step 6 (parity) is enforced by the
 * sync script itself (it removes stale entries and writes from the
 * single source of truth), so a successful exit equals parity.
 *
 * Returns `{ ok, stdout }`.
 */
export function runSyncCommands(ctx) {
  const script = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'scripts',
    'sync-claude-commands.js',
  );
  const result = spawnSync(process.execPath, [script], {
    cwd: ctx.projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `[bootstrap] sync-claude-commands.js failed (exit ${result.status}): ${(
        result.stderr ?? ''
      )
        .trim()
        .slice(0, 400)}`,
    );
  }
  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

/**
 * Step 6 — Parity check between `.agents/workflows/*.md` and
 * `.claude/commands/*.md`. Step 5's sync already enforces this; this is
 * a belt-and-braces verification.
 */
export function checkParity(ctx) {
  const workflowsDir = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'workflows',
  );
  const commandsDir = path.join(ctx.projectRoot, '.claude', 'commands');
  const list = (dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => e.name.replace(/\.md$/, ''))
          .sort()
      : [];
  const workflows = new Set(list(workflowsDir));
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
 * Step 9 — Windows git-perf hints (warn-only). On non-Windows this is a
 * silent no-op. On Windows the check probes three settings and reports
 * which are missing; it never mutates global git config.
 */
export function checkWindowsGitPerf(ctx) {
  if (os.platform() !== 'win32') {
    return { platform: process.platform, skipped: true };
  }
  const script = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'scripts',
    'check-windows-git-perf.js',
  );
  if (!fs.existsSync(script)) {
    return { platform: 'win32', skipped: true, reason: 'script-missing' };
  }
  const result = spawnSync(process.execPath, [script], {
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

// ---------------------------------------------------------------------------
// BOOTSTRAP_PHASES (Story #2459 / Task #2473)
//
// The previous `applyProjectBootstrap` was an 11-step inline pipeline with
// three fatal-abort branches (`nodeCheck`, `validation`, `parity`). Each
// phase is now a declarative `{ name, run, isFatal?, formatError? }`
// entry. The single-pass driver `runPhases` reads the array, calls each
// `run(ctx, report)`, accumulates the result onto `report[phase.name]`,
// and routes fatal phases through `throwIfFatal` so the abort message
// remains operator-visible.
//
// `applyProjectBootstrap` collapses to two lines: instantiate an empty
// report, hand it to `runPhases`, return it.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BootstrapPhase
 * @property {string} name       — key used to land the result on the report.
 * @property {(ctx: object, report: object) => any|Promise<any>} run
 *                                 — executes the phase. May read prior
 *                                   phases via `report.<name>`.
 * @property {boolean} [isFatal]  — when `true`, the driver passes the
 *                                   result through `formatError`; if the
 *                                   formatter returns a non-empty string,
 *                                   the driver throws with that message.
 * @property {(result: any) => string|null} [formatError]
 *                                 — produces the error message when the
 *                                   phase result indicates a fatal abort.
 */

const fatalNodeCheck = (result) =>
  result.ok
    ? null
    : `[bootstrap] Node ${result.version} is below required ${result.required}.x. Upgrade Node and re-run.`;

const fatalValidation = (result) =>
  result.ok
    ? null
    : `[bootstrap] .agentrc.json failed schema validation: ${JSON.stringify(
        result.errors,
        null,
        2,
      )}`;

const fatalParity = (result) =>
  result.ok
    ? null
    : `[bootstrap] Parity check failed — workflows missing commands: ${
        result.missingCommand.join(', ') || '(none)'
      }; orphan commands: ${result.orphanCommand.join(', ') || '(none)'}`;

/**
 * Pipeline definition — the order, the helpers, and the fatal-abort
 * branches. Exported so tests can assert phase ordering, the fatal flag,
 * and the report-shape parity guarantee without driving the whole
 * bootstrap.
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
    run: (ctx) => ensurePackageJson(ctx),
  },
  {
    name: 'install',
    run: (ctx, report) => ensureDependenciesInstalled(ctx, report.pkg),
  },
  {
    name: 'agentrc',
    run: (ctx) => ensureAgentrc(ctx),
  },
  {
    name: 'validation',
    run: async (ctx) => validateAgentrc(ctx),
    isFatal: true,
    formatError: fatalValidation,
  },
  {
    name: 'claudeSettings',
    run: (ctx) => ensureClaudeSettings(ctx),
  },
  {
    name: 'gitignore',
    run: (ctx) => ensureGitignore(ctx),
  },
  {
    name: 'sync',
    run: (ctx) => runSyncCommands(ctx),
  },
  {
    name: 'parity',
    run: (ctx) => checkParity(ctx),
    isFatal: true,
    formatError: fatalParity,
  },
  {
    name: 'quality',
    run: (ctx) =>
      ctx.skipQuality
        ? { skipped: true }
        : applyQualityBootstrap({ projectRoot: ctx.projectRoot }),
  },
  {
    name: 'winPerf',
    run: (ctx) => checkWindowsGitPerf(ctx),
  },
]);

/**
 * Throw with the formatted message when the phase is marked fatal and
 * the result indicates an abort. Pure helper so the driver stays a
 * single-branch loop.
 *
 * Exported for tests.
 *
 * @param {BootstrapPhase} phase
 * @param {any} result
 */
export function throwIfFatal(phase, result) {
  if (!phase.isFatal) return;
  const msg = phase.formatError?.(result);
  if (typeof msg === 'string' && msg.length > 0) throw new Error(msg);
}

/**
 * Iterate `phases` in order; await each phase's `run(ctx, report)`, land
 * the result on `report[phase.name]`, then route fatal phases through
 * `throwIfFatal`. Returns the accumulated report.
 *
 * Exported for tests so phase ordering and fatal behaviour can be
 * asserted without spawning a full bootstrap.
 *
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
 * Compose every step in order. Each returned key is the outcome of one
 * step so the CLI can render a structured summary.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.agentRoot]
 * @param {{ owner: string, repo: string, baseBranch: string,
 *           operatorHandle: string|null }} ctx.answers
 * @param {boolean} [ctx.skipQuality]
 * @param {boolean} [ctx.skipInstall]
 * @param {boolean} [ctx.quiet]
 * @returns {Promise<object>}
 */
export async function applyProjectBootstrap(ctx) {
  return runPhases(BOOTSTRAP_PHASES, ctx);
}
