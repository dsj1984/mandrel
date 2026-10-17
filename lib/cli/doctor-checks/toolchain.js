// lib/cli/doctor-checks/toolchain.js — Doctor checks: node-version, git-available, gh-available, github-token, gh-auth.
// Every `gh` probe goes through `runGh`, so it runs with the configured `GH_CONFIG_DIR`.

import {
  REQUIRED_NODE_CEILING_MAJOR,
  REQUIRED_NODE_FLOOR,
  satisfiesNodeEngine,
} from '../../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { runGh } from '../../../.agents/scripts/lib/gh-exec.js';
import { spawn } from './spawn.js';

// check: node-version

/**
 * @param {{ nodeVersion?: string }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runNodeVersion({ nodeVersion = process.versions.node } = {}) {
  const ok = satisfiesNodeEngine(nodeVersion);
  const detail = `v${nodeVersion} (required >=${REQUIRED_NODE_FLOOR} <${REQUIRED_NODE_CEILING_MAJOR})`;
  if (ok) return { ok: true, detail };
  return {
    ok: false,
    detail,
    remedy: `Upgrade Node to >=${REQUIRED_NODE_FLOOR} <${REQUIRED_NODE_CEILING_MAJOR}: https://nodejs.org/`,
  };
}

// check: git-available

/**
 * @param {{ runner?: (cmd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException } }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runGitAvailable({ runner = spawn } = {}) {
  const r = runner('git', ['--version']);
  if (r.error?.code === 'ENOENT' || r.status !== 0) {
    const snippet = (r.stderr || r.stdout || '').trim().slice(0, 120);
    return {
      ok: false,
      detail: snippet || 'git not found on PATH',
      remedy: 'Install git: https://git-scm.com/downloads — then re-run.',
    };
  }
  return { ok: true, detail: r.stdout.trim().split('\n')[0] };
}

// check: gh-available

/**
 * @param {{ runner?: (cmd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException } }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runGhAvailable({ runner = spawn } = {}) {
  const r = runGh(['--version'], {}, runner);
  if (r.error?.code === 'ENOENT' || r.status !== 0) {
    const snippet = (r.stderr || r.stdout || '').trim().slice(0, 120);
    return {
      ok: false,
      detail: snippet || 'gh not found on PATH',
      remedy: 'Install gh CLI: https://cli.github.com/ — then re-run.',
    };
  }
  return { ok: true, detail: r.stdout.trim().split('\n')[0] };
}

// check: github-token

/**
 * Resolve a token the way `providers/github/auth.js#resolveToken` does: env
 * `GITHUB_TOKEN`/`GH_TOKEN`, else `gh auth token`. The CLI does not load
 * `.env`, so an env-only check would false-block `gh auth login` users.
 *
 * @param {{ env?: Record<string,string|undefined>,
 *   runner?: (cmd: string, args: string[]) => {
 *     status: number|null, stdout: string, stderr: string,
 *     error?: NodeJS.ErrnoException } }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runGithubToken({ env = process.env, runner = spawn } = {}) {
  const envToken = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (envToken && envToken.length > 0) {
    return { ok: true, detail: 'GITHUB_TOKEN set' };
  }
  const r = runGh(['auth', 'token'], {}, runner);
  const ghToken = !r.error && r.status === 0 ? (r.stdout || '').trim() : '';
  if (ghToken.length > 0) {
    return { ok: true, detail: 'token resolved via `gh auth token`' };
  }
  return {
    ok: false,
    detail: 'no GitHub token (env unset, `gh auth token` returned nothing)',
    remedy:
      'Run `gh auth login` (the CLI resolves the token via `gh auth token`), or export GITHUB_TOKEN=<your-token>.',
  };
}

// check: gh-auth

/**
 * `gh auth status` live-validates the token, which an Actions installation
 * token (and some fine-grained tokens) cannot pass even though they work for
 * everything mandrel does. The runtime never consults it, so a failing status
 * with an env token present is warn-and-skip (ok); only "no token and not
 * logged in" fails.
 *
 * @param {{ runner?: (cmd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }, env?: Record<string,string|undefined> }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runGhAuth({ runner = spawn, env = process.env } = {}) {
  const r = runGh(['auth', 'status'], {}, runner);
  if (r.error?.code === 'ENOENT') {
    return {
      ok: false,
      detail: 'gh not found — auth check skipped',
      remedy: 'Install the GitHub CLI: https://cli.github.com',
    };
  }
  if (r.status !== 0) {
    const envToken = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (envToken && envToken.length > 0) {
      return {
        ok: true,
        detail:
          '`gh auth status` could not validate the active token, but GITHUB_TOKEN/GH_TOKEN is set (the runtime authenticates non-interactively with it)',
      };
    }
    return {
      ok: false,
      detail: 'not logged in',
      remedy:
        'Run `gh auth login` (choose GitHub.com → HTTPS → login with a web browser), then re-run.',
    };
  }
  const output = (r.stdout + r.stderr).trim();
  const match = /Logged in to \S+ as (\S+)/i.exec(output);
  const detail = match ? `logged in as ${match[1]}` : 'logged in';
  return { ok: true, detail };
}
