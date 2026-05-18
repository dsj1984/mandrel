/**
 * bootstrap/prompt — interactive prompt + CLI flag helpers for bootstrap.js.
 *
 * Uses Node's built-in `readline/promises` so the bootstrap stays
 * dependency-free. Provides:
 *
 *   - `parseFlags(argv)`            — minimal arg parser for the flags the
 *                                     bootstrap CLI accepts.
 *   - `inferDefaults(projectRoot)`  — derives default values for owner /
 *                                     repo / baseBranch / operatorHandle
 *                                     from the project's git remote and
 *                                     config (no network calls).
 *   - `collectAnswers({ flags, defaults, interactive })` — resolves every
 *                                     required value, prompting only for
 *                                     values not supplied via flag.
 *
 * In non-TTY contexts the helper refuses to prompt and returns the
 * accumulated answers; callers must decide whether the remaining required
 * fields are satisfied via flags/env.
 */

import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';

/**
 * Flags the bootstrap CLI accepts. Keep this list in sync with the
 * `--help` text in bootstrap.js.
 */
export const KNOWN_FLAGS = Object.freeze({
  string: ['owner', 'repo', 'operator-handle', 'base-branch', 'project-number'],
  boolean: ['assume-yes', 'skip-github', 'skip-quality', 'help', 'dry-run'],
});

/**
 * Parse a minimal `--flag value` / `--flag=value` / `--boolean` argv.
 *
 * Unknown long flags become string flags (last-write-wins) so callers can
 * forward through to nested scripts without losing data.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : tok.slice(eq + 1);
    if (KNOWN_FLAGS.boolean.includes(name)) {
      out[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    if (inlineValue !== undefined) {
      out[name] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[name] = next;
      i++;
    } else {
      out[name] = true;
    }
  }
  return out;
}

/**
 * Parse `owner/repo` out of a git remote URL. Supports HTTPS, SSH, and
 * `git@host:owner/repo.git` forms. Returns `null` when the URL is empty
 * or not recognisable.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGitRemoteUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  const trimmed = url.trim().replace(/\.git$/, '');
  // git@github.com:owner/repo
  const sshMatch = /^[\w.-]+@[\w.-]+:([^/]+)\/([^/]+)$/.exec(trimmed);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  // https://github.com/owner/repo  or  ssh://git@host/owner/repo
  const urlMatch = /^[a-z]+:\/\/[^/]+\/([^/]+)\/([^/]+)$/i.exec(trimmed);
  if (urlMatch) {
    const owner = urlMatch[1].replace(/^git@[\w.-]+:/, '');
    return { owner, repo: urlMatch[2] };
  }
  return null;
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd });
  if (result.status !== 0) return '';
  return (result.stdout ?? '').trim();
}

/**
 * Derive defaults for the interactive prompts from the project's git
 * config. No network calls — only inspects the local remote/config.
 *
 * @param {string} projectRoot
 * @returns {{ owner: string|null, repo: string|null, baseBranch: string,
 *             operatorHandle: string|null }}
 */
export function inferDefaults(projectRoot) {
  const remoteUrl = runGit(['remote', 'get-url', 'origin'], projectRoot);
  const parsed = parseGitRemoteUrl(remoteUrl);
  const headRef =
    runGit(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      projectRoot,
    ).replace(/^origin\//, '') || 'main';
  const userName = runGit(['config', '--get', 'user.name'], projectRoot);
  const operatorHandle =
    userName && /^[A-Za-z0-9-]+$/.test(userName) ? userName : null;
  return {
    owner: parsed?.owner ?? null,
    repo: parsed?.repo ?? null,
    baseBranch: headRef,
    operatorHandle,
  };
}

// ---------------------------------------------------------------------------
// Resolver chain (Story #2459 / Task #2470)
//
// `collectAnswers` used to be a 60-line for-loop with seven `continue`
// branches — flag, env, silent-accept, interactive (with re-ask), assume-yes,
// missing-required. The branches all had the same shape: "try to produce a
// value; if you have one, record it and move on". Each branch is now a
// dedicated `resolveFrom*` helper that returns one of three outcomes:
//
//   { kind: 'value',   value }  — accepted this answer; stop trying resolvers.
//   { kind: 'missing' }         — required-but-empty; record on `missing[]`.
//   { kind: 'skip' }            — this resolver doesn't apply; try the next.
//
// `collectAnswers` becomes a two-level loop: for each question, walk the
// `RESOLVERS` array in priority order. Each resolver is testable in
// isolation and measures CC < 8 independently.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ResolverContext
 * @property {object} q                — The question definition.
 * @property {Record<string, string|boolean>} flags
 * @property {NodeJS.ProcessEnv} env
 * @property {Set<string>} silentSet   — Keys whose default should be
 *                                       accepted without prompting.
 * @property {boolean} interactive
 * @property {boolean} assumeYes
 * @property {() => Promise<readline.Interface>} getRl — Lazy readline factory
 *                                       that returns the same instance across
 *                                       calls within one collectAnswers run.
 * @property {NodeJS.WritableStream} output
 */

/**
 * Resolver 1 — CLI flag wins outright.
 * @param {ResolverContext} ctx
 * @returns {{ kind: 'value'|'skip', value?: string }}
 */
export function resolveFromFlag(ctx) {
  const flagValue = ctx.flags[ctx.q.flag];
  if (typeof flagValue === 'string' && flagValue.length > 0) {
    return { kind: 'value', value: flagValue };
  }
  return { kind: 'skip' };
}

/**
 * Resolver 2 — env var override.
 * @param {ResolverContext} ctx
 * @returns {{ kind: 'value'|'skip', value?: string }}
 */
export function resolveFromEnv(ctx) {
  const envName = ctx.q.env;
  if (!envName) return { kind: 'skip' };
  const envValue = ctx.env[envName];
  if (typeof envValue === 'string' && envValue.length > 0) {
    return { kind: 'value', value: envValue };
  }
  return { kind: 'skip' };
}

/**
 * Resolver 3 — silent-accept default (key was inferred from local git state
 * and no operator override was supplied).
 * @param {ResolverContext} ctx
 * @returns {{ kind: 'value'|'skip', value?: string }}
 */
export function resolveFromSilent(ctx) {
  if (!ctx.silentSet.has(ctx.q.key)) return { kind: 'skip' };
  const def = ctx.q.default;
  if (typeof def !== 'string' || def.length === 0) return { kind: 'skip' };
  return { kind: 'value', value: def };
}

/**
 * Prompt once with the question's default label, applying the default when
 * the operator pressed Enter on an empty line. Pure I/O; exported so
 * `resolveInteractive` can be unit-tested with a mocked readline.
 *
 * @param {readline.Interface} rl
 * @param {object} q
 * @returns {Promise<string>}
 */
async function askOnce(rl, q) {
  const defaultLabel = q.default ? ` [${q.default}]` : '';
  const raw = await rl.question(`${q.message}${defaultLabel}: `);
  const trimmed = raw.trim();
  if (trimmed.length === 0 && q.default) return q.default;
  return trimmed;
}

/**
 * Resolver 4 — interactive prompt. Asks once; if `q.validate` rejects, the
 * helper re-asks once more before declaring the answer missing.
 *
 * @param {ResolverContext} ctx
 * @returns {Promise<{ kind: 'value'|'missing'|'skip', value?: string }>}
 */
export async function resolveInteractive(ctx) {
  if (!ctx.interactive) return { kind: 'skip' };
  const rl = await ctx.getRl();
  const q = ctx.q;
  let answer = await askOnce(rl, q);
  const firstErr = q.validate ? q.validate(answer) : null;
  if (firstErr) {
    ctx.output.write(`  ! ${firstErr}\n`);
    answer = await askOnce(rl, q);
    if (q.validate?.(answer)) return { kind: 'missing' };
  }
  if (answer.length === 0 && q.required) return { kind: 'missing' };
  return { kind: 'value', value: answer };
}

/**
 * Resolver 5 — non-interactive `--assume-yes` fallback. Accepts the
 * question's default verbatim; emits `missing` for required questions that
 * lack a default.
 *
 * @param {ResolverContext} ctx
 * @returns {{ kind: 'value'|'missing'|'skip', value?: string }}
 */
export function resolveAssumeYes(ctx) {
  if (!ctx.assumeYes) return { kind: 'skip' };
  if (ctx.q.default) return { kind: 'value', value: ctx.q.default };
  if (ctx.q.required) return { kind: 'missing' };
  return { kind: 'skip' };
}

/**
 * Priority-ordered list of resolvers. Each is tried in turn until one
 * returns a non-`skip` outcome. Exported for testing.
 */
export const RESOLVERS = Object.freeze([
  resolveFromFlag,
  resolveFromEnv,
  resolveFromSilent,
  resolveInteractive,
  resolveAssumeYes,
]);

/**
 * Walk the question list and resolve a value for each. Each question is
 * routed through the `RESOLVERS` chain in priority order; the first
 * resolver to return `{ kind: 'value' }` wins, `{ kind: 'missing' }` adds
 * the key to `missing[]`, and `{ kind: 'skip' }` continues the chain. If
 * every resolver skips a *required* question, the key is recorded as
 * missing so callers can decide whether to abort.
 *
 * Returns `{ answers, missing }` so the CLI can decide whether to abort
 * (non-TTY with missing required fields and no `--assume-yes`).
 *
 * @param {object} args
 * @param {Array<{ key: string, flag: string, env?: string, message: string,
 *                  default?: string|null, required?: boolean,
 *                  validate?: (v: string) => string|null }>} args.questions
 * @param {Record<string, string|boolean>} args.flags
 * @param {boolean} args.interactive
 * @param {boolean} args.assumeYes
 * @param {Iterable<string>} [args.silentAccept] Keys whose `q.default`
 *   should be accepted without prompting (when no flag/env overrides).
 * @param {NodeJS.ReadableStream} [args.input=process.stdin]
 * @param {NodeJS.WritableStream} [args.output=process.stdout]
 * @returns {Promise<{ answers: Record<string, string>, missing: string[] }>}
 */
export async function collectAnswers(args) {
  const {
    questions,
    flags,
    interactive,
    assumeYes,
    silentAccept,
    input = process.stdin,
    output = process.stdout,
  } = args;
  const silentSet = new Set(silentAccept ?? []);
  const answers = {};
  const missing = [];
  let rl = null;
  const getRl = async () => {
    rl ??= readline.createInterface({ input, output });
    return rl;
  };
  try {
    for (const q of questions) {
      const ctx = {
        q,
        flags,
        env: process.env,
        silentSet,
        interactive,
        assumeYes,
        getRl,
        output,
      };
      let outcome = { kind: 'skip' };
      for (const resolver of RESOLVERS) {
        outcome = await resolver(ctx);
        if (outcome.kind !== 'skip') break;
      }
      if (outcome.kind === 'value') {
        answers[q.key] = outcome.value;
        continue;
      }
      if (outcome.kind === 'missing') {
        missing.push(q.key);
        continue;
      }
      // Every resolver skipped — record as missing only if required.
      if (q.required) missing.push(q.key);
    }
  } finally {
    rl?.close();
  }
  return { answers, missing };
}
