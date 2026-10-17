// lib/cli/doctor-checks/project-access.js — Doctor check: github-project-access.

import fs from 'node:fs';
import path from 'node:path';

import { applyLocalOverlay } from '../../../.agents/scripts/lib/config/agentrc-overlay.js';
import { runGh } from '../../../.agents/scripts/lib/gh-exec.js';
import { isInsufficientScopes } from '../../../.agents/scripts/providers/github/projects-v2-graphql.js';
import { readJsonSafe } from './read-json.js';
import { spawn } from './spawn.js';

const REMEDY = 'Run `gh auth refresh -h github.com -s project`, then re-run.';

// A gh that cannot authenticate at all is gh-auth's failure, not this one's.
const GH_AUTH_RE = /gh auth login|not logged in|Bad credentials|HTTP 401/i;

/**
 * `github.projectNumber` / `github.owner` from `.agentrc.json`, with
 * `.agentrc.local.json` deep-merged over it (the resolver's one overlay).
 *
 * @param {string} projectRoot
 * @param {{ readFileSync: Function }} fsImpl
 * @returns {{ projectNumber: number|null, owner: string|null }}
 */
function readBoardConfig(projectRoot, fsImpl) {
  const committed =
    readJsonSafe(path.join(projectRoot, '.agentrc.json'), fsImpl) ?? {};
  const github = effectiveConfig(fsImpl, projectRoot, committed).github ?? {};
  const n = Number(github.projectNumber);
  return {
    projectNumber: Number.isInteger(n) && n > 0 ? n : null,
    owner:
      typeof github.owner === 'string' && github.owner ? github.owner : null,
  };
}

/** The overlay merged over `committed`; an unparseable overlay is ignored here (the config check reports it). */
function effectiveConfig(fsImpl, projectRoot, committed) {
  try {
    return applyLocalOverlay({ fsImpl, projectRoot, committed }).effective;
  } catch {
    return committed;
  }
}

/** One rung's query: `organization` / `user` by login, else `viewer`. */
function rungArgs(root, owner, projectNumber) {
  const query = owner
    ? `query($owner:String!,$number:Int!){${root}(login:$owner){projectV2(number:$number){id}}}`
    : `query($number:Int!){viewer{projectV2(number:$number){id}}}`;
  const args = ['api', 'graphql', '-f', `query=${query}`];
  if (owner) args.push('-f', `owner=${owner}`);
  args.push('-F', `number=${projectNumber}`);
  return args;
}

/**
 * Probe one rung.
 *
 * @returns {'found'|'miss'|'scope'|'defer'}
 */
function probeRung(runner, root, owner, projectNumber) {
  const r = runGh(
    rungArgs(root, owner, projectNumber),
    { timeout: 20_000 },
    runner,
  );
  if (r.error) return 'defer';
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (isInsufficientScopes({ message: output })) return 'scope';
  if (r.status !== 0 && GH_AUTH_RE.test(output)) return 'defer';
  try {
    const json = JSON.parse(r.stdout || '{}');
    if (json?.data?.[root]?.projectV2?.id) return 'found';
  } catch {
    // Non-JSON output is a miss for this rung.
  }
  return 'miss';
}

// check: github-project-access

/**
 * Can the active token read the configured Projects v2 board? No board →
 * skipped; a gh that cannot run defers to `gh-auth`.
 *
 * @param {{ cwd?: () => string, fsImpl?: typeof fs, runner?: typeof spawn }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runProjectAccess({ cwd, fsImpl = fs, runner = spawn } = {}) {
  const projectRoot = (cwd ?? (() => process.cwd()))();
  const { projectNumber, owner } = readBoardConfig(projectRoot, fsImpl);
  if (!projectNumber) {
    return {
      ok: true,
      detail: 'skipped — no github.projectNumber configured',
    };
  }
  const roots = owner ? ['organization', 'user'] : ['viewer'];
  const target = `project #${projectNumber}${owner ? ` for ${owner}` : ''}`;
  for (const root of roots) {
    const outcome = probeRung(runner, root, owner, projectNumber);
    if (outcome === 'found') return { ok: true, detail: `${target} readable` };
    if (outcome === 'defer') {
      return {
        ok: true,
        detail: 'skipped — gh cannot run or authenticate (see gh-auth)',
      };
    }
    if (outcome === 'scope') {
      return {
        ok: false,
        detail: `token lacks the "project" scope — cannot read ${target}; board adds and Status flips are being skipped`,
        remedy: REMEDY,
      };
    }
  }
  return {
    ok: false,
    detail: `${target} not found`,
    remedy:
      'Check github.projectNumber and github.owner in .agentrc.json (or `gh auth refresh -h github.com -s project` if the board is private).',
  };
}
