/**
 * bootstrap/project-bootstrap — deterministic project bootstrap steps.
 *
 * Each exported `ensure*` function is one step of the bootstrap. Every step
 * is idempotent and additive — re-running on an already-bootstrapped clone
 * produces zero file mutations and zero network I/O.
 *
 * Injectable seams: every function that performs filesystem I/O or spawns a
 * child process accepts an optional `fsImpl` / `spawnImpl` default-param so
 * unit tests can stub I/O without touching the real filesystem. The seam
 * contract is defined in `.agents/rules/test-seams.md`.
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
import { PHASE_GROUPS, previewMutationManifest } from './manifest.js';
import { applyQualityBootstrap } from './quality-bootstrap.js';

export const SYNC_COMMAND = 'node .agents/scripts/sync-claude-commands.js';

// Epic #4478 (M7-B). The role-scoped agent projection runs in every place the
// command projection does — `sync:agents` script, `prepare`, and the bootstrap
// `sync` phase (`runSyncCommands`) — so `.claude/agents/*.md` materializes for
// hosts that read it, exactly as `.claude/commands/*.md` does.
export const SYNC_AGENTS_COMMAND = 'node .agents/scripts/sync-claude-agents.js';

export const BOOTSTRAP_COMMAND = 'node .agents/scripts/bootstrap.js';

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
    pattern: /^\s*\.claude\/commands\/?\s*$/m,
    block:
      '\n# Claude Code command projection is generated from .agents/workflows/ — do not commit.\n.claude/commands/\n',
  },
  mcp: {
    pattern: /^\s*\.mcp\.json\s*$/m,
    block:
      '\n# Project-scoped MCP config carries secrets — keep out of git.\n.mcp.json\n',
  },
  // Story #3894: `.env` holds real secrets (`mandrel init` instructs operators
  // to put `GITHUB_TOKEN` here). It MUST be ignored by default so a cold-start
  // provision never stages/pushes it. The pattern matches a bare `.env` (with
  // an optional trailing slash) but deliberately NOT `.env.example`, the
  // committed placeholder that `security-baseline.md` § Secrets Management
  // exempts.
  env: {
    pattern: /^\s*\.env\/?\s*$/m,
    block:
      '\n# Secrets live in .env (e.g. GITHUB_TOKEN) — never commit it. Only .env.example (placeholders) is checked in.\n.env\n',
  },
  // Story #3894: the install ledger is a per-clone install record, not a
  // checked-in source artifact. `install-ledger.js` documents that the
  // bootstrap `.gitignore` step ignores it — key the entry off the exact
  // `LEDGER_RELATIVE_PATH` constant so the doc and code never drift again.
  installLedger: {
    pattern: new RegExp(
      `^\\s*${LEDGER_RELATIVE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm',
    ),
    block: `\n# Per-clone install record written by bootstrap — not a source artifact.\n${LEDGER_RELATIVE_PATH}\n`,
  },
});

/**
 * Read a JSON file if it exists; return null when missing. Accepts an
 * injectable `fsImpl` so callers can stub filesystem access in tests.
 *
 * @param {string} p
 * @param {typeof fs} [fsImpl]
 * @returns {object|null}
 */
function readJsonIfExists(p, fsImpl = fs) {
  if (!fsImpl.existsSync(p)) return null;
  return JSON.parse(fsImpl.readFileSync(p, 'utf8'));
}

/**
 * Write a pretty-printed JSON file, creating parent directories as needed.
 * Accepts an injectable `fsImpl` so callers can stub filesystem access in
 * tests.
 *
 * @param {string} p
 * @param {object} obj
 * @param {typeof fs} [fsImpl]
 */
function writeJson(p, obj, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(p), { recursive: true });
  fsImpl.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * The minimum Node.js patch version mandrel requires.
 *
 * Rationale: `22.22.1` is the Node 22 LTS patch that ships with the
 * `node:sqlite` built-in (`--experimental-sqlite` removed from flag
 * requirement in 22.5.0, but the module stabilised at 22.22.1 per the
 * Node 22 LTS changelog). Pinning to this patch prevents silent failures on
 * older 22.x installs that lack the built-in. CI exercises `node-version: 22`
 * which resolves to the latest 22.x (always ≥ 22.22.1 in the current GHA
 * environment), so CI validates the contract without exercising the exact
 * patch floor — the floor is enforced at install time, not in CI.
 *
 * Single source of truth: `registry.js` and any other consumer MUST import
 * this constant rather than duplicating it.
 *
 * Matches `package.json` `engines.node` (`>=22.22.1 <25`).
 */
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
 * `npm` when no lock is found (including the `null` case from the shared
 * helper where no Node manifest exists at all).
 *
 * Delegates to the shared `detectPackageManager` helper
 * (Story #4048 B3 — one implementation per concept).
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {'pnpm'|'yarn'|'npm'}
 */
export function detectPackageManager(projectRoot, fsImpl = fs) {
  return detectPm(projectRoot, (p) => fsImpl.existsSync(p)) ?? 'npm';
}

/**
 * Step 2a/2b/2c — Ensure `package.json` exists and carries the
 * `sync:commands` + `prepare` + `bootstrap` scripts. The consumer manifest
 * is never mutated with framework runtime dependencies: those arrive
 * transitively via the `mandrel` package, so bootstrap leaves the
 * `dependencies` block untouched (Story #3466). Returns the per-key outcome
 * the caller can render.
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
    // Append each projection independently so an existing prepare that already
    // carries the command sync still gains the agent sync on the next bootstrap
    // (and both are idempotent — a prepare carrying both is left untouched).
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
    outcomes.scriptsSyncAgents === 'added' ||
    outcomes.scriptsPrepare !== 'already-present' ||
    outcomes.scriptsBootstrap === 'added';
  if (mutated) writeJson(pkgPath, pkg, fsImpl);
  return { ...outcomes, path: pkgPath, mutated };
}

/**
 * Step 2d — Install dependencies when the framework's sentinel module is
 * unresolvable. Bootstrap no longer seeds framework deps into the consumer
 * manifest (Story #3466) — they arrive transitively via `mandrel`
 * — so the install is triggered purely by an empty/stale `node_modules`.
 * Returns `{ ran, manager, skipped, reason }`.
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
 * Step 2.5a — Seed `.agentrc.json` when missing.
 *
 * Seeds from the bundled `starter-agentrc.json` reference, applying the
 * operator-identity placeholder substitution (`[OWNER]` / `[REPO]` /
 * `[USERNAME]`) and the `baseBranch` override. (Story #3690 removed the
 * named config-profile seeding path — the starter reference is the single
 * seed source.)
 *
 * An existing `.agentrc.json` is never overwritten — operator wins.
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
  // The starter pins baseBranch to "main"; if the operator chose a
  // different default, update the seeded copy so the per-clone config
  // matches the live remote HEAD.
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
 * Step 2.5b — Validate `.agentrc.json` against the framework's AJV schema.
 * Returns `{ ok, errors }`. Caller decides whether to abort.
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
  // pathToFileURL handles Windows drive letters and percent-encoding
  // correctly (same fix as commit 2e3d210b in lib/transpile.js).
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

// Story #4527/#4530: the UserPromptSubmit sync-hook wiring
// (ensureClaudeSettings, formerly Step 3) was removed. It spawned
// `mandrel sync-commands` on every prompt to keep `.claude/commands/` in
// sync with `.agents/workflows/` — a rewrite racing the harness's own read
// of that same directory while expanding a slash command, and a directory
// that cannot change mid-session in the first place, so the hook reported
// `0 file(s) synced` on effectively every invocation. The real sync points
// already cover every case: `prepare` on install, `mandrel sync` /
// `mandrel update` on upgrade, and doctor's `commands-in-sync` check for
// hand-edits. `lib/cli/uninstall.js#revertClaudeSettings` still removes the
// hook from a consumer who already has it installed from a prior version.

/**
 * Step 4 + Step 8 — Ensure `.gitignore` carries every {@link GITIGNORE_BLOCKS}
 * entry (`.claude/commands/`, `.mcp.json`, `.env`, and the per-clone install
 * ledger). Each block is marker-keyed off a presence pattern, so a re-run is a
 * zero-mutation no-op and never appends a duplicate block. Returns a per-block
 * outcome (`added` | `already-present`).
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
 * Materialize the generated GitHub Issue Forms
 * (`.github/ISSUE_TEMPLATE/story.yml`) into the consumer
 * project (Story #4227). Derived from the Story-body SSOT so a human-filed
 * ticket round-trips through `story-body.parse()`. Idempotent and additive,
 * mirroring `ensureGitignore`: byte-identical forms are `unchanged`,
 * operator-edited forms are preserved (`custom-skip`). Honours `ctx.preview`
 * (no writes) like the other phases.
 *
 * Returns the per-form action envelope keyed by ticket type.
 *
 * Internal — consumed only by the `issueForms` entry in
 * {@link BOOTSTRAP_PHASES} below.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {boolean} [ctx.preview]
 */
function ensureIssueFormsPhase(ctx) {
  const { forms } = ensureIssueForms({
    projectRoot: ctx.projectRoot,
    write: !ctx.preview,
  });
  const outcomes = {};
  for (const form of forms) {
    outcomes[form.type] = { action: form.action, path: form.path };
  }
  return outcomes;
}

/**
 * Step 5 — Run the sync script. Step 6 (parity) is enforced by the
 * sync script itself (it removes stale entries and writes from the
 * single source of truth), so a successful exit equals parity.
 *
 * Returns `{ ok, stdout }`.
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
  // Both projections run here (Epic #4478, M7-B): the command tree AND the
  // role-scoped agent tree, so `mandrel sync` / the postinstall path
  // materializes `.claude/agents/*.md` alongside `.claude/commands/*.md`.
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
 * Step 6 — Parity check between `.agents/workflows/*.md` and the generated
 * flat command tree `.claude/commands/*.md`. Step 5's sync already enforces
 * this; this is a belt-and-braces verification that the command projection
 * covers every top-level workflow.
 *
 * A workflow whose frontmatter carries `command: false` is deliberately NOT
 * projected to a command — `sync-claude-commands.js` skips it via the same
 * `isCommandExcluded` predicate used here. Such a workflow must therefore be
 * excluded from the expected-command set, or this check would demand a
 * command the sync is contracted never to emit (e.g. the `audit-lighthouse` /
 * `audit-security` lenses, which are run by the audit suite, not as slash
 * commands). Keeping the two surfaces on one predicate is what stops them
 * drifting.
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
  // Expected commands = projectable workflows only. A `command: false`
  // workflow is contracted out of the command tree, so it is not "missing" a
  // command — it declined one.
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
 * Step 9 — Windows git-perf hints (warn-only). On non-Windows this is a
 * silent no-op. On Windows the check probes three settings and reports
 * which are missing; it never mutates global git config.
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
 * @param {boolean} [ctx.withQuality]
 * @param {boolean} [ctx.skipGithub]
 * @param {boolean} [ctx.skipInstall]
 * @param {boolean} [ctx.quiet]
 * @param {typeof fs} [ctx.fsImpl]       — injectable filesystem seam (test-seams.md).
 * @param {typeof defaultSpawnSync} [ctx.spawnImpl] — injectable spawn seam (test-seams.md).
 * @returns {Promise<object>}
 */
export async function applyProjectBootstrap(ctx) {
  if (ctx.preview) return previewMutationManifest(ctx);
  return runPhases(BOOTSTRAP_PHASES, ctx);
}
