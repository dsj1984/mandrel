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

/**
 * Walk the question list and resolve a value for each, in priority order:
 *   1. CLI flag (`flags[question.flag]`).
 *   2. Environment variable (`process.env[question.env]`) when defined.
 *   3. Silent-accept default when the question's key is in `silentAccept`
 *      and `q.default` is non-empty (used to skip prompting for values
 *      already inferred from local git state).
 *   4. Interactive prompt with the supplied default (only when
 *      `interactive` is true).
 *   5. The supplied default (only when `assumeYes` is true).
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
  try {
    for (const q of questions) {
      const flagValue = flags[q.flag];
      if (typeof flagValue === 'string' && flagValue.length > 0) {
        answers[q.key] = flagValue;
        continue;
      }
      const envValue = q.env ? process.env[q.env] : undefined;
      if (typeof envValue === 'string' && envValue.length > 0) {
        answers[q.key] = envValue;
        continue;
      }
      if (
        silentSet.has(q.key) &&
        typeof q.default === 'string' &&
        q.default.length > 0
      ) {
        answers[q.key] = q.default;
        continue;
      }
      if (interactive) {
        rl ??= readline.createInterface({ input, output });
        const defaultLabel = q.default ? ` [${q.default}]` : '';
        let answer = (
          await rl.question(`${q.message}${defaultLabel}: `)
        ).trim();
        if (answer.length === 0 && q.default) answer = q.default;
        const err = q.validate ? q.validate(answer) : null;
        if (err) {
          output.write(`  ! ${err}\n`);
          // re-ask once; on second failure record as missing
          answer = (await rl.question(`${q.message}${defaultLabel}: `)).trim();
          if (answer.length === 0 && q.default) answer = q.default;
          if (q.validate?.(answer)) {
            missing.push(q.key);
            continue;
          }
        }
        if (answer.length === 0 && q.required) {
          missing.push(q.key);
          continue;
        }
        answers[q.key] = answer;
        continue;
      }
      // Non-interactive: fall back to default when --assume-yes is set.
      if (assumeYes && q.default) {
        answers[q.key] = q.default;
        continue;
      }
      if (q.required) missing.push(q.key);
    }
  } finally {
    rl?.close();
  }
  return { answers, missing };
}
