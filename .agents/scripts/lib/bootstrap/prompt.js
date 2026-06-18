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
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

/**
 * Flags the bootstrap CLI accepts. Keep this list in sync with the
 * `--help` text in bootstrap.js.
 */
export const KNOWN_FLAGS = Object.freeze({
  string: [
    'owner',
    'repo',
    'operator-handle',
    'base-branch',
    'project-number',
    'visibility',
  ],
  boolean: [
    'assume-yes',
    'approve-github-admin',
    'skip-github',
    'with-quality',
    'help',
    'dry-run',
    'reap-conflicting-workflows',
  ],
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
 * Read the already-stored `github.projectNumber` from an existing
 * `.agentrc.json` in `projectRoot`, returned as a numeric string (the shape
 * the `projectNumber` question default expects). Returns `null` when the
 * file is missing, unparseable, or carries no integer project number.
 *
 * This is the authoritative default for an already-provisioned project on a
 * bootstrap re-run: surfacing the stored number (rather than the repo name)
 * means an `--assume-yes` re-run resolves a numeric answer, which
 * `detectCreation` classifies as an *existing* project — so no duplicate
 * board is created (Story #3896 / review Finding B.3).
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function inferStoredProjectNumber(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectRoot, '.agentrc.json'), 'utf8');
  } catch {
    return null;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return null;
  }
  const number = config?.github?.projectNumber;
  return Number.isInteger(number) ? String(number) : null;
}

/**
 * Derive defaults for the interactive prompts from the project's git
 * config. No network calls — only inspects the local remote/config and the
 * stored `.agentrc.json` (for the already-provisioned project number).
 *
 * @param {string} projectRoot
 * @returns {{ owner: string|null, repo: string|null, baseBranch: string,
 *             operatorHandle: string|null, projectNumber: string|null }}
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
    projectNumber: inferStoredProjectNumber(projectRoot),
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
 * Resolver — interactive numbered-menu picker. Sits between
 * `resolveFromSilent` and `resolveInteractive` so an operator who declined
 * the silent default still gets a live menu of real choices (e.g. their
 * GitHub repos / projects) before falling back to free-text entry.
 *
 * The question opts in by carrying an optional `picker: { list }` field,
 * where `list(answers)` is a function returning an array of string choices
 * (commonly a `gh-list` provider). It receives the answers resolved so far,
 * so a later question can list against an earlier answer — e.g. the repo /
 * project pickers fetching the just-entered owner's repos/projects, which is
 * the only owner available when the folder has no git remote to infer from.
 * The resolver returns `kind: 'skip'` — falling through to manual entry via
 * `resolveInteractive` — in three cases:
 *
 *   1. not interactive (`ctx.interactive` is false),
 *   2. the question has no `picker` (or no callable `picker.list`),
 *   3. the provider returns an empty list (no choices to render).
 *
 * Otherwise it renders a numbered menu, reads a selection via `ctx.getRl()`,
 * and returns the chosen value. A blank line or an out-of-range / unparseable
 * selection also falls through to manual entry (`kind: 'skip'`) rather than
 * looping, keeping the resolver single-shot and predictable.
 *
 * @param {ResolverContext} ctx
 * @returns {Promise<{ kind: 'value'|'skip', value?: string }>}
 */
export async function resolveFromPicker(ctx) {
  if (!ctx.interactive) return { kind: 'skip' };
  const picker = ctx.q.picker;
  if (!picker || typeof picker.list !== 'function') return { kind: 'skip' };

  const choices = (await picker.list(ctx.answers)) ?? [];
  if (!Array.isArray(choices) || choices.length === 0) return { kind: 'skip' };

  const normalized = choices.map(normalizePickerChoice);
  const rl = await ctx.getRl();
  // The picker header uses `pickerMessage` when set, so a question can show
  // list-oriented guidance here (e.g. "Select existing or press ENTER to create
  // new one") while the manual-entry fall-through prompt (`askOnce`) uses the
  // shorter `message` (e.g. "New GitHub repo name"). Falls back to `message`.
  ctx.output.write(`${ctx.q.pickerMessage ?? ctx.q.message}:\n`);
  normalized.forEach((choice, index) => {
    ctx.output.write(`  ${index + 1}) ${choice.label}\n`);
  });
  const raw = await rl.question('  Select a number (or press Enter to type): ');
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'skip' };
  const selection = Number.parseInt(trimmed, 10);
  if (
    !Number.isInteger(selection) ||
    selection < 1 ||
    selection > normalized.length
  ) {
    return { kind: 'skip' };
  }
  const value = normalized[selection - 1].value;
  // A picker must never bypass the validation the manual path enforces.
  if (ctx.q.validate) {
    const err = ctx.q.validate(value);
    if (err) {
      ctx.output.write(`  ! ${err}\n`);
      return { kind: 'skip' };
    }
  }
  return { kind: 'value', value };
}

/**
 * Normalize a picker choice into a `{ label, value }` pair. A bare string
 * choice uses the same text for both; an object choice carries an explicit
 * `label` shown in the menu and `value` returned on selection. Exported for
 * unit testing.
 *
 * @param {string | { label?: string, value?: string }} choice
 * @returns {{ label: string, value: string }}
 */
export function normalizePickerChoice(choice) {
  if (choice && typeof choice === 'object') {
    const value = String(choice.value ?? '');
    const label = String(choice.label ?? value);
    return { label, value };
  }
  const text = String(choice);
  return { label: text, value: text };
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
  resolveFromPicker,
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
        // Answers resolved so far (questions run in order), so a later
        // question's picker can key off an earlier answer — e.g. the repo /
        // project pickers listing against the owner just entered.
        answers,
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
