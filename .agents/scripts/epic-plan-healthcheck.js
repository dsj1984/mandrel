#!/usr/bin/env node

/* node:coverage ignore file */

/**
 * epic-plan-healthcheck.js — Post-Plan Readiness Check
 *
 * Runs at the end of /plan (Phase 10) to validate the backlog and
 * optionally prime the execution environment before handing off to
 * /epic-deliver.
 *
 * Modes (additive — the fast checks below always run):
 *   (default)         — config validation + git remote check only.
 *                       Targets <2s.
 *   --paranoid        — adds ticket-hierarchy revalidation plus a
 *                       navigability-reachability semantic check (silent
 *                       no-op unless `planning.navigation.routeGlobs` is
 *                       configured).
 *   --prime-install   — adds the pnpm content-addressable-store priming
 *                       path (up to 300s).
 *
 * Output: a single line of structured JSON on stdout —
 *   { ok, degraded, reason, checks: [{name, ok, durationMs, detail}] }
 *
 * The script always exits 0; callers decide whether to act on `ok: false`.
 * The plan is already committed to GitHub, so failing the script does not
 * un-create tickets.
 *
 * Usage:
 *   node epic-plan-healthcheck.js --epic <EPIC_ID> \
 *     [--paranoid] [--prime-install] [--dry-run]
 *
 * @see .agents/workflows/helpers/plan-epic.md Phase 10
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseTicketId } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';

const progress = Logger.createProgress('plan-healthcheck', { stderr: true });

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

/**
 * Parse the healthcheck-specific CLI surface. Kept local to the script so the
 * shared `parseSprintArgs` helper does not have to learn about every script's
 * private flags.
 *
 * @param {string[]} [argv]
 * @returns {{ epicId: number|null, paranoid: boolean,
 *   primeInstall: boolean, dryRun: boolean }}
 */
function parseHealthcheckArgs(argv = process.argv) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      epic: { type: 'string', short: 'e' },
      paranoid: { type: 'boolean', default: false },
      'prime-install': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    epicId: parseTicketId(values.epic) ?? parseTicketId(positionals[0]),
    paranoid: !!values.paranoid,
    primeInstall: !!values['prime-install'],
    dryRun: !!values['dry-run'],
  };
}

// ---------------------------------------------------------------------------
// Individual checks
//
// Each check returns { ok: boolean, detail: string }. The orchestrator wraps
// it with `name` and `durationMs` for the structured output.
// ---------------------------------------------------------------------------

/** Validate the resolved `.agentrc.json` config. */
function checkConfig(config) {
  try {
    validateOrchestrationConfig(config);
    return { ok: true, detail: 'Config is valid.' };
  } catch (err) {
    return { ok: false, detail: `Config validation failed: ${err.message}` };
  }
}

/** Verify `origin` is reachable and `baseBranch` exists on it. */
function checkGitRemote(baseBranch, cwd) {
  const remote = gitSpawn(
    cwd,
    'ls-remote',
    '--exit-code',
    'origin',
    baseBranch,
  );
  if (remote.status === 0) {
    return {
      ok: true,
      detail: `Remote reachable, base branch '${baseBranch}' exists.`,
    };
  }
  if (
    remote.stderr.includes('Could not resolve host') ||
    remote.stderr.includes('unable to access')
  ) {
    return {
      ok: false,
      detail: `Git remote 'origin' is not reachable: ${remote.stderr.slice(0, 200)}`,
    };
  }
  return {
    ok: false,
    detail: `Base branch '${baseBranch}' not found on origin.`,
  };
}

/**
 * Detect whether a Story body carries an inline `## Acceptance` section with
 * at least one checklist item. Epic #3078 — under 2-tier hierarchy, Stories
 * carry acceptance inline, so the hierarchy check uses this signal as the
 * mark of a complete, executable Story.
 *
 * @param {string} body
 * @returns {boolean}
 */
function hasInlineAcceptance(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  const match = body.match(/^##\s+Acceptance\s*$/im);
  if (!match) return false;
  const tail = body.slice(match.index + match[0].length);
  // Capture until the next top-level `## ` heading (or EOF).
  const sectionEnd = tail.search(/^##\s+\S/m);
  const section = sectionEnd === -1 ? tail : tail.slice(0, sectionEnd);
  // A non-empty acceptance section needs at least one bullet (with or
  // without a checkbox marker).
  return /^\s*-\s+(?:\[[ xX]\]\s+)?\S/m.test(section);
}

/**
 * Validate Epic ticket hierarchy. 2-tier is the only supported hierarchy
 * after Task #3154 deleted `planning.hierarchy`: every Story must carry an
 * inline `## Acceptance` checklist; there is no Task layer to graph.
 *
 * @param {object} provider
 * @param {number|null} epicId
 */
async function checkTickets(provider, epicId) {
  if (!epicId) {
    return {
      ok: false,
      detail: '--paranoid requires --epic <ID> to fetch the ticket hierarchy.',
    };
  }

  let tickets;
  try {
    tickets = await provider.getSubTickets(epicId);
  } catch (err) {
    return {
      ok: false,
      detail: `Could not fetch Epic #${epicId} tickets: ${err.message}`,
    };
  }

  if (tickets.length === 0) {
    return { ok: false, detail: `Epic #${epicId} has no child tickets.` };
  }

  const stories = tickets.filter((t) => t.labels.includes(TYPE_LABELS.STORY));

  const errors = [];
  if (stories.length === 0) errors.push('no type::story tickets');

  const missingAcceptance = stories.filter(
    (s) => !hasInlineAcceptance(s.body ?? ''),
  );
  if (missingAcceptance.length > 0) {
    const ids = missingAcceptance.map((s) => `#${s.id}`).join(', ');
    errors.push(
      `${missingAcceptance.length} story/stories missing inline acceptance: ${ids}`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, detail: errors.join('; ') };
  }

  const missingComplexity = stories.filter(
    (s) => !s.labels.some((l) => l.startsWith('complexity::')),
  );
  const advisory =
    missingComplexity.length > 0
      ? ` (advisory: ${missingComplexity.length} story/stories missing complexity label)`
      : '';

  return {
    ok: true,
    detail: `${stories.length} stories (2-tier, inline acceptance) — hierarchy valid${advisory}.`,
  };
}

/**
 * Resolve the navigation config that drives the reachability check.
 *
 * The check is opt-in: a consumer that has not configured
 * `planning.navigation.routeGlobs` gets a silent no-op (F7 / AC-13). The
 * nav-registry token list is what a route-adding Story is expected to
 * reference somewhere in its body or `## Acceptance` section.
 *
 * @param {object} config Resolved `.agentrc.json`.
 * @returns {{ routeGlobs: string[], navRegistry: string[] }}
 */
function resolveNavConfig(config) {
  const nav = config?.planning?.navigation ?? {};
  const toList = (v) =>
    (Array.isArray(v) ? v : v == null ? [] : [v])
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
  return {
    routeGlobs: toList(nav.routeGlobs),
    navRegistry: toList(nav.navRegistry),
  };
}

/**
 * Translate a route glob (`pages/**`, `app/**\/route.ts`) into a RegExp that
 * matches a path string. Supports `**` (any depth, including `/`), `*` (any
 * run of non-separator chars), and `?` (single non-separator char). All other
 * characters are matched literally.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  // Collapse adjacent `**` segments before compiling. `**/**` and `***` both
  // mean "any depth", but compiling them literally emits adjacent `.*` runs
  // (`.*/.*` / `.*.*`) that backtrack catastrophically on a long non-matching
  // path. Collapsing to a single `**` preserves semantics and keeps the
  // matcher linear (ReDoS hardening — Epic #4131 audit follow-up).
  const normalized = glob
    .replace(/\*\*(?:\/\*\*)+/g, '**')
    .replace(/\*{3,}/g, '**');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Extract the candidate route-touching paths a Story declares. Reads the
 * `## Changes` block (the decompose-author emits one `{"path":...}` JSON
 * object per bullet) and falls back to any bare ```` `path/like/this` ````
 * inline-code spans in the body.
 *
 * @param {string} body
 * @returns {string[]}
 */
function extractStoryPaths(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const paths = new Set();
  // `{"path":"pages/foo.tsx", ...}` change descriptors.
  for (const m of body.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
    paths.add(m[1]);
  }
  // Inline-code spans that look like a path (contain a slash or a dotted ext).
  for (const m of body.matchAll(/`([^`]+)`/g)) {
    const token = m[1].trim();
    if (/[/.]/.test(token) && !token.includes(' ')) paths.add(token);
  }
  return [...paths];
}

/**
 * Return the `## Acceptance` + full-body text a Story is expected to reference
 * the nav registry from. The whole body is searched (the registry can be cited
 * in the Goal, Changes, or Acceptance), so this just lower-cases the body once.
 *
 * @param {string} body
 * @returns {string}
 */
function referenceableText(body) {
  return typeof body === 'string' ? body.toLowerCase() : '';
}

/**
 * Navigability-reachability semantic check (F7 / AC-8).
 *
 * Flags every Story that adds a route (touches a path matching a configured
 * `planning.navigation.routeGlobs` entry) but whose body / acceptance never
 * references the configured nav registry. Silent no-op (returns ok with an
 * explicit detail) when no route-glob config is present.
 *
 * @param {object} provider
 * @param {number|null} epicId
 * @param {object} config
 */
async function checkReachability(provider, epicId, config) {
  const { routeGlobs, navRegistry } = resolveNavConfig(config);

  // Opt-in: unconfigured consumers degrade to a silent no-op.
  if (routeGlobs.length === 0) {
    return {
      ok: true,
      detail: 'No planning.navigation.routeGlobs configured — skipped.',
    };
  }

  if (!epicId) {
    return {
      ok: false,
      detail:
        'reachability check requires --epic <ID> to fetch the ticket hierarchy.',
    };
  }

  let tickets;
  try {
    tickets = await provider.getSubTickets(epicId);
  } catch (err) {
    return {
      ok: false,
      detail: `Could not fetch Epic #${epicId} tickets: ${err.message}`,
    };
  }

  const stories = tickets.filter((t) => t.labels.includes(TYPE_LABELS.STORY));
  const matchers = routeGlobs.map(globToRegExp);
  const registryTokens = navRegistry.map((t) => t.toLowerCase());

  const flagged = [];
  for (const story of stories) {
    const body = story.body ?? '';
    const addsRoute = extractStoryPaths(body).some((p) =>
      matchers.some((rx) => rx.test(p)),
    );
    if (!addsRoute) continue;

    const text = referenceableText(body);
    // When no explicit registry token is configured, fall back to the
    // generic "nav registry" phrase so a route-adding Story is still
    // expected to mention the navigation surface.
    const tokens =
      registryTokens.length > 0
        ? registryTokens
        : ['nav registry', 'navigation'];
    const referencesRegistry = tokens.some((tok) => text.includes(tok));
    if (!referencesRegistry) flagged.push(`#${story.id}`);
  }

  if (flagged.length > 0) {
    const registryHint =
      navRegistry.length > 0 ? navRegistry.join(', ') : 'the nav registry';
    return {
      ok: false,
      detail: `${flagged.length} route-adding story/stories never reference ${registryHint}: ${flagged.join(', ')}`,
    };
  }

  return {
    ok: true,
    detail: `${stories.length} stories scanned — every route-adding story references the nav registry.`,
  };
}

/** Prime the pnpm content-addressable store via `pnpm install --frozen-lockfile`. */
function primePnpmStore(cwd, dryRun) {
  const lockFile = path.join(cwd, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockFile)) {
    return {
      ok: false,
      detail: 'No pnpm-lock.yaml found — cannot prime store.',
    };
  }
  if (dryRun) {
    return { ok: true, detail: 'pnpm store prime skipped (dry-run).' };
  }

  progress('PRIME', 'Priming pnpm content-addressable store...');
  const start = Date.now();
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 300_000,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (result.status === 0) {
    return { ok: true, detail: `pnpm store primed in ${elapsed}s.` };
  }
  const reason =
    result.signal === 'SIGTERM'
      ? `timeout after ${elapsed}s`
      : `exit ${result.status}`;
  return {
    ok: false,
    detail: `pnpm store prime failed (${reason}). First worktree install will be slower. stderr: ${(result.stderr ?? '').slice(0, 300)}`,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function timed(name, fn) {
  const start = Date.now();
  const { ok, detail } = await fn();
  return { name, ok, durationMs: Date.now() - start, detail };
}

/**
 * Run the post-plan health check.
 *
 * @param {object} [opts]
 * @param {number} [opts.epicId]              Epic ID (required for --paranoid).
 * @param {boolean} [opts.paranoid]           Add ticket-hierarchy revalidation.
 * @param {boolean} [opts.primeInstall]       Add pnpm-store priming.
 * @param {boolean} [opts.dryRun]             Skip real install side effects.
 * @param {object}  [opts.injectedProvider]   Test-only injection point.
 * @param {object}  [opts.injectedConfig]     Test-only injection point.
 * @returns {Promise<{ok: boolean, degraded: boolean, reason: string|null,
 *   checks: Array<{name: string, ok: boolean, durationMs: number, detail: string}>}>}
 */
// exported for tests — direct-unit coverage of the reachability semantics.
export { checkReachability, extractStoryPaths, globToRegExp };

// exported for tests — Story-level reuse runner reserved for future test coverage
export async function runPlanHealthcheck(opts = {}) {
  const ARG_KEYS = ['epicId', 'paranoid', 'primeInstall', 'dryRun'];
  const hasExplicitArgs = ARG_KEYS.some((k) => Object.hasOwn(opts, k));
  const parsed = hasExplicitArgs
    ? {
        epicId: opts.epicId ?? null,
        paranoid: !!opts.paranoid,
        primeInstall: !!opts.primeInstall,
        dryRun: !!opts.dryRun,
      }
    : parseHealthcheckArgs();

  const { epicId, paranoid, primeInstall, dryRun } = parsed;
  const cwd = PROJECT_ROOT;

  const config = opts.injectedConfig || resolveConfig();
  const baseBranch = config.project?.baseBranch ?? 'main';

  progress(
    'HEALTH',
    `Running post-plan health check${epicId ? ` for Epic #${epicId}` : ''} (mode=${paranoid ? 'paranoid' : 'fast'}${primeInstall ? '+prime-install' : ''})...`,
  );

  const checks = [];

  // Fast lane: config + git remote always run.
  progress('CHECK', 'Validating resolved config...');
  checks.push(await timed('config', async () => checkConfig(config)));

  progress('CHECK', 'Checking git remote...');
  checks.push(
    await timed('git-remote', async () => checkGitRemote(baseBranch, cwd)),
  );

  // Paranoid lane: ticket-hierarchy revalidation (2-tier only) plus the
  // navigability-reachability semantic check (silent no-op when unconfigured).
  if (paranoid) {
    const provider = opts.injectedProvider || createProvider(config);
    progress('CHECK', 'Validating ticket hierarchy...');
    checks.push(
      await timed('ticket-hierarchy', () => checkTickets(provider, epicId)),
    );
    progress('CHECK', 'Checking route-reachability (nav registry)...');
    checks.push(
      await timed('reachability', () =>
        checkReachability(provider, epicId, config),
      ),
    );
  }

  // Optional pnpm-store priming.
  if (primeInstall) {
    progress('CHECK', 'Priming pnpm store...');
    checks.push(
      await timed('prime-install', async () => primePnpmStore(cwd, dryRun)),
    );
  }

  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  const result = {
    ok,
    degraded: !ok,
    reason: ok ? null : failed.map((c) => `${c.name}: ${c.detail}`).join('; '),
    checks,
  };

  if (ok) {
    progress('HEALTH', `All ${checks.length} check(s) passed.`);
  } else {
    progress(
      'HEALTH',
      `${failed.length} of ${checks.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}.`,
    );
  }

  // The structured result is the only thing on stdout.
  Logger.info(JSON.stringify(result));

  return result;
}

// ---------------------------------------------------------------------------
// Main guard
// ---------------------------------------------------------------------------

runAsCli(import.meta.url, runPlanHealthcheck, {
  source: 'epic-plan-healthcheck',
});
