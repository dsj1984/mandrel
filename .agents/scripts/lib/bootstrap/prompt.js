/**
 * Dependency-free prompt and CLI-flag helpers for bootstrap.js. Never prompts
 * in non-TTY contexts; callers decide whether missing fields are fatal.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

/** Keep in sync with the `--help` text in bootstrap.js. */
const KNOWN_FLAGS = Object.freeze({
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
 * Unknown long flags become string flags so they can be forwarded.
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
 * Stored `github.projectNumber` as a numeric string. A re-run must default to
 * it so `detectCreation` sees an existing project and no duplicate board is made.
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
 * Prompt defaults from local git state and `.agentrc.json`; no network calls.
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

// Resolvers return `{ kind: 'value', value }` (stop), `{ kind: 'missing' }`
// (required-but-empty) or `{ kind: 'skip' }` (try the next resolver).

/**
 * @typedef {object} ResolverContext
 * @property {object} q
 * @property {Record<string, string|boolean>} flags
 * @property {NodeJS.ProcessEnv} env
 * @property {Set<string>} silentSet   — Keys whose default is accepted unprompted.
 * @property {boolean} interactive
 * @property {boolean} assumeYes
 * @property {() => Promise<readline.Interface>} getRl — Lazy, one instance per run.
 * @property {NodeJS.WritableStream} output
 */

/**
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
 * Numbered-menu picker for questions carrying `picker.list(answers)`, which
 * sees earlier answers (e.g. the owner just entered). Single-shot: no choices
 * or a blank/invalid selection falls through to manual entry.
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
 * An empty line takes the default.
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
 * Re-asks once on a validation failure before declaring the answer missing.
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
 * @param {ResolverContext} ctx
 * @returns {{ kind: 'value'|'missing'|'skip', value?: string }}
 */
export function resolveAssumeYes(ctx) {
  if (!ctx.assumeYes) return { kind: 'skip' };
  if (ctx.q.default) return { kind: 'value', value: ctx.q.default };
  if (ctx.q.required) return { kind: 'missing' };
  return { kind: 'skip' };
}

/** Priority order; the first non-`skip` outcome wins. */
export const RESOLVERS = Object.freeze([
  resolveFromFlag,
  resolveFromEnv,
  resolveFromSilent,
  resolveFromPicker,
  resolveInteractive,
  resolveAssumeYes,
]);

/**
 * Resolve each question through `RESOLVERS`; the CLI decides whether `missing` aborts.
 *
 * @param {object} args
 * @param {Array<{ key: string, flag: string, env?: string, message: string,
 *                  default?: string|null, required?: boolean,
 *                  validate?: (v: string) => string|null }>} args.questions
 * @param {Record<string, string|boolean>} args.flags
 * @param {boolean} args.interactive
 * @param {boolean} args.assumeYes
 * @param {Iterable<string>} [args.silentAccept]
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
        // Resolved so far, so a later picker can key off an earlier answer.
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
      if (q.required) missing.push(q.key);
    }
  } finally {
    rl?.close();
  }
  return { answers, missing };
}
