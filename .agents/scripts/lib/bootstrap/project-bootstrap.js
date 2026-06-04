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
import { buildProfileAgentrcBody } from '../config/sync-agentrc.js';
import { PHASE_GROUPS, previewMutationManifest } from './manifest.js';
import { applyQualityBootstrap } from './quality-bootstrap.js';

export const SYNC_COMMAND = 'node .agents/scripts/sync-claude-commands.js';

export const BOOTSTRAP_COMMAND = 'node .agents/scripts/bootstrap.js';

/**
 * Plugin / marketplace identity for the generated Claude Code plugin
 * projection (Story #3576). Kept in sync with the writer in
 * `.agents/scripts/sync-claude-commands.js` (`PLUGIN_NAME` / `MARKETPLACE_NAME`).
 * Commands are invocable as `/mandrel:<name>`.
 */
export const PLUGIN_NAME = 'mandrel';
export const MARKETPLACE_NAME = 'mandrel';

/**
 * `enabledPlugins` key Claude Code uses to enable the repo-local plugin: the
 * `<plugin>@<marketplace>` pair. Written into the consumer's
 * `.claude/settings.json` so teammates get the plugin enabled on clone.
 */
export const PLUGIN_ENABLEMENT_KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/**
 * `extraKnownMarketplaces` entry registering the repo-local marketplace from a
 * directory source. The generated marketplace listing lives at
 * `.claude/.claude-plugin/marketplace.json`, so the source directory is
 * `./.claude` (relative to the project root). Checked into the consumer's
 * `.claude/settings.json` so the plugin loads with no hosted marketplace.
 */
export const MARKETPLACE_SOURCE = Object.freeze({
  source: 'directory',
  path: './.claude',
});

/**
 * Marker that identifies the framework's system-prompt import inside a
 * consumer `CLAUDE.md`. The wiring step keys idempotence off this exact
 * import path so a re-run never duplicates the import line.
 */
export const SYSTEM_PROMPT_IMPORT = '@.agents/instructions.md';

/**
 * Import block appended to an existing `CLAUDE.md` that lacks the import.
 * Mirrors the root `CLAUDE.md` shape (a `## System Prompt` heading above
 * the import) so the consumer file reads the same as this repo's own.
 */
export const SYSTEM_PROMPT_BLOCK = `## System Prompt

${SYSTEM_PROMPT_IMPORT}
`;

/**
 * Full `CLAUDE.md` body written when the consumer has no `CLAUDE.md` at
 * all. A bare title plus the import block is enough for Claude Code to
 * hydrate the framework system prompt on cold start.
 */
export const SYSTEM_PROMPT_CLAUDE_MD = `# Agent Protocols

${SYSTEM_PROMPT_BLOCK}`;

export const GITIGNORE_BLOCKS = Object.freeze({
  commands: {
    pattern: /^\s*\.claude\/plugins\/mandrel\/?\s*$/m,
    block:
      '\n# Claude Code plugin projection is generated from .agents/workflows/ — do not commit.\n.claude/plugins/mandrel/\n.claude/.claude-plugin/\n.claude/commands/\n',
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

/** Matches root `package.json` `engines.node`. */
export const REQUIRED_NODE_FLOOR = '22.22.1';
export const REQUIRED_NODE_CEILING_MAJOR = 25;

/**
 * Return true when `version` satisfies `>=22.22.1 <25` (same as `engines`).
 *
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
 * Step 1 — Verify Node satisfies `engines.node`. Returns `{ ok, version,
 * required }` so the CLI can report the detected version regardless of
 * whether the check passed.
 *
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
 * `sync:commands` + `prepare` + `bootstrap` scripts. The consumer manifest
 * is never mutated with framework runtime dependencies: those arrive
 * transitively via the `@mandrelai/agents` package, so bootstrap leaves the
 * `dependencies` block untouched (Story #3466). Returns the per-key outcome
 * the caller can render.
 */
export function ensurePackageJson(ctx) {
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  const projectName = path.basename(path.resolve(ctx.projectRoot));
  const outcomes = {
    created: false,
    scriptsSyncCommands: 'already-present',
    scriptsPrepare: 'already-present',
    scriptsBootstrap: 'already-present',
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
  // Expose a discoverable `npm run bootstrap` alias for the framework
  // setup command. An operator-defined `bootstrap` script always wins —
  // we only seed the default when the key is absent.
  if (!pkg.scripts.bootstrap) {
    pkg.scripts.bootstrap = BOOTSTRAP_COMMAND;
    outcomes.scriptsBootstrap = 'added';
  }
  const mutated =
    outcomes.created ||
    outcomes.scriptsSyncCommands === 'added' ||
    outcomes.scriptsPrepare !== 'already-present' ||
    outcomes.scriptsBootstrap === 'added';
  if (mutated) writeJson(pkgPath, pkg);
  return { ...outcomes, path: pkgPath, mutated };
}

/**
 * Step 2d — Install dependencies when the framework's sentinel module is
 * unresolvable. Bootstrap no longer seeds framework deps into the consumer
 * manifest (Story #3466) — they arrive transitively via `@mandrelai/agents`
 * — so the install is triggered purely by an empty/stale `node_modules`.
 * Returns `{ ran, manager, skipped, reason }`.
 */
export function ensureDependenciesInstalled(ctx) {
  const manager = detectPackageManager(ctx.projectRoot);
  const sentinel = path.join(
    ctx.projectRoot,
    'node_modules',
    'ajv',
    'package.json',
  );
  const needsInstall = !fs.existsSync(sentinel);
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
 * Step 2.5a — Seed `.agentrc.json` when missing.
 *
 * Two seeding sources, selected by whether the operator picked a named
 * config profile (Story #3527):
 *
 *   - **Profile selected** (`ctx.answers.profile` is a known profile name):
 *     seed from that profile's delta via
 *     {@link buildProfileAgentrcBody}. The minimal `solo-local` profile
 *     yields a correspondingly minimal `.agentrc.json` scoped to that
 *     posture — the repo-config phase seeds from the chosen profile delta
 *     rather than the full reference config.
 *   - **No profile** (`ctx.answers.profile` blank/absent): seed from the
 *     bundled `starter-agentrc.json` reference (the historical default).
 *
 * Both sources apply the same operator-identity placeholder substitution
 * (`[OWNER]` / `[REPO]` / `[USERNAME]`) and `baseBranch` override.
 *
 * An existing `.agentrc.json` is never overwritten — operator wins. A
 * profile name that fails to resolve/validate propagates as a throw so the
 * fatal `validation` phase never runs against a half-written file.
 *
 * @returns {{ action: string, path: string, source?: string,
 *   profile?: string }}
 */
export function ensureAgentrc(ctx) {
  const target = path.join(ctx.projectRoot, '.agentrc.json');
  if (fs.existsSync(target)) {
    return { action: 'already-present', path: target };
  }
  const profile = ctx.answers.profile;
  if (typeof profile === 'string' && profile.length > 0) {
    const body = buildProfileAgentrcBody({ profile, answers: ctx.answers });
    fs.writeFileSync(target, body, 'utf8');
    return { action: 'seeded', path: target, source: 'profile', profile };
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
  return { action: 'seeded', path: target, source: 'starter' };
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
 * Ensure the plugin-enablement keys are present in a settings object. Wires
 * the repo-local marketplace (`extraKnownMarketplaces`) and enables the plugin
 * (`enabledPlugins`) so the generated `/mandrel:<name>` commands load with no
 * hosted marketplace. Mutates `settings` in place and returns true when it
 * changed anything (idempotent — re-running is a no-op).
 *
 * Bundling this with the sync hook in the *same* bootstrap step is the
 * sequencing guard (Story #3576): the consumer never ends up with the flat
 * bare commands removed while the plugin is still disabled.
 *
 * @param {object} settings
 * @returns {boolean} mutated
 */
function ensurePluginEnablement(settings) {
  let mutated = false;
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces ?? {};
  if (!settings.extraKnownMarketplaces[MARKETPLACE_NAME]) {
    settings.extraKnownMarketplaces[MARKETPLACE_NAME] = {
      source: { ...MARKETPLACE_SOURCE },
    };
    mutated = true;
  }
  settings.enabledPlugins = settings.enabledPlugins ?? {};
  if (settings.enabledPlugins[PLUGIN_ENABLEMENT_KEY] !== true) {
    settings.enabledPlugins[PLUGIN_ENABLEMENT_KEY] = true;
    mutated = true;
  }
  return mutated;
}

/**
 * Step 3 — Merge the `UserPromptSubmit` sync hook **and** the plugin
 * enablement keys into `.claude/settings.json`. Returns `{ action }`.
 *
 * The sync hook keeps the generated `/mandrel:<name>` command tree current;
 * the enablement keys (`extraKnownMarketplaces` + `enabledPlugins`) make the
 * repo-local plugin load. Both land in one step so the flat-command removal
 * and the plugin enablement are a single atomic change (Story #3576).
 */
export function ensureClaudeSettings(ctx) {
  const target = path.join(ctx.projectRoot, '.claude', 'settings.json');
  const hook = { type: 'command', command: SYNC_COMMAND };
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fresh = {
      extraKnownMarketplaces: {
        [MARKETPLACE_NAME]: { source: { ...MARKETPLACE_SOURCE } },
      },
      enabledPlugins: { [PLUGIN_ENABLEMENT_KEY]: true },
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
  const hookAlready = settings.hooks.UserPromptSubmit.some((group) =>
    (group?.hooks ?? []).some(
      (h) =>
        typeof h?.command === 'string' &&
        h.command.includes('sync-claude-commands.js'),
    ),
  );
  let mutated = false;
  if (!hookAlready) {
    settings.hooks.UserPromptSubmit.push({ hooks: [hook] });
    mutated = true;
  }
  if (ensurePluginEnablement(settings)) mutated = true;
  if (!mutated) return { action: 'already-present', path: target };
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
 * Step 6 — Parity check between `.agents/workflows/*.md` and the generated
 * plugin command tree `.claude/plugins/mandrel/commands/*.md` (Story #3576).
 * Step 5's sync already enforces this; this is a belt-and-braces verification
 * that the plugin projection covers every top-level workflow.
 */
export function checkParity(ctx) {
  const workflowsDir = path.join(
    ctx.agentRoot ?? path.join(ctx.projectRoot, '.agents'),
    'workflows',
  );
  const commandsDir = path.join(
    ctx.projectRoot,
    '.claude',
    'plugins',
    PLUGIN_NAME,
    'commands',
  );
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
 * Step 8.5 — Wire the framework system prompt into a consumer `CLAUDE.md`.
 *
 * Claude Code hydrates its always-loaded context from a project-root
 * `CLAUDE.md`; without the `@.agents/instructions.md` import the framework
 * system prompt never loads on cold start. This step makes that wiring
 * automatic and idempotent:
 *
 *   - No `CLAUDE.md` at all → write a minimal one carrying the import.
 *   - `CLAUDE.md` exists but lacks the import → append the import block.
 *   - `CLAUDE.md` already imports it → no-op (no duplicate import line).
 *
 * Idempotence is keyed off the literal `SYSTEM_PROMPT_IMPORT` path, so a
 * re-run on an already-wired file is a guaranteed zero-mutation no-op.
 *
 * Returns `{ action, path }` where `action` is one of `created`,
 * `appended`, or `already-present`.
 */
export function ensureSystemPromptWiring(ctx) {
  const target = path.join(ctx.projectRoot, 'CLAUDE.md');
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, SYSTEM_PROMPT_CLAUDE_MD, 'utf8');
    return { action: 'created', path: target };
  }
  const existing = fs.readFileSync(target, 'utf8');
  if (existing.includes(SYSTEM_PROMPT_IMPORT)) {
    return { action: 'already-present', path: target };
  }
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(
    target,
    `${existing}${separator}\n${SYSTEM_PROMPT_BLOCK}`,
    'utf8',
  );
  return { action: 'appended', path: target };
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
    : `[bootstrap] Node ${result.version} is below required ${result.required}. Upgrade Node and re-run.`;

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
 *
 * Each project-side mutation phase carries a `phaseGroup` matching one of
 * the consent-first {@link PHASE_GROUPS}. When a phased-approval gate is
 * supplied via `ctx.approvedGroups`, a phase whose `phaseGroup` is not in
 * the approved set is skipped (recorded as a `phase-group-declined` no-op)
 * — declining one group never short-circuits the others (Story #3524).
 * Phases with no `phaseGroup` (the Node-version precondition and the
 * dependency install) are always-run infrastructure, never gated.
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
    name: 'claudeSettings',
    phaseGroup: PHASE_GROUPS.IDE_WIRING,
    run: (ctx) => ensureClaudeSettings(ctx),
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
 * Decide whether a phase should run given the approved-phase-group gate.
 * An always-run infrastructure phase (no `phaseGroup`) runs unconditionally.
 * A grouped phase runs only when no gate is supplied (`approvedGroups`
 * absent — the un-gated legacy path) or when its group is in the gate.
 *
 * Exported for unit testing.
 *
 * @param {BootstrapPhase} phase
 * @param {Set<string>|undefined} approvedGroups
 * @returns {boolean}
 */
export function isPhaseApproved(phase, approvedGroups) {
  if (!phase.phaseGroup) return true;
  if (!approvedGroups) return true;
  return approvedGroups.has(phase.phaseGroup);
}

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
 * When `ctx.approvedGroups` is a `Set`, a grouped phase whose `phaseGroup`
 * is not approved is skipped and recorded as
 * `{ skipped: true, reason: 'phase-group-declined', phaseGroup }` — it never
 * runs, never throws (so a declined `ide-wiring` group also skips its
 * fatal `parity` check), and never short-circuits the remaining phases.
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
    if (!isPhaseApproved(phase, ctx.approvedGroups)) {
      report[phase.name] = {
        skipped: true,
        reason: 'phase-group-declined',
        phaseGroup: phase.phaseGroup,
      };
      continue;
    }
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
 * When `ctx.preview` is truthy, the function performs **no writes and no
 * network I/O**. Instead it derives the operator-facing change list from
 * the single mutation-manifest source ({@link previewMutationManifest}) and
 * returns `{ preview: true, groups, entries }` — the exact same source the
 * consent-first install screen renders. Deriving the preview from
 * `buildMutationManifest` (rather than from a parallel hand-maintained list)
 * guarantees the preview the operator approves and the execution that
 * follows enumerate one identical set of mutations (Story #3521).
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.agentRoot]
 * @param {{ owner: string, repo: string, baseBranch: string,
 *           operatorHandle: string|null }} ctx.answers
 * @param {boolean} [ctx.preview]   — no-write preview from the manifest.
 * @param {Set<string>} [ctx.approvedGroups] — when present, only phases
 *   whose `phaseGroup` is in this set execute (the consent-first gate from
 *   Story #3524); always-run infrastructure phases ignore it.
 * @param {boolean} [ctx.skipQuality]
 * @param {boolean} [ctx.skipGithub]
 * @param {boolean} [ctx.skipInstall]
 * @param {boolean} [ctx.quiet]
 * @returns {Promise<object>}
 */
export async function applyProjectBootstrap(ctx) {
  if (ctx.preview) return previewMutationManifest(ctx);
  return runPhases(BOOTSTRAP_PHASES, ctx);
}
