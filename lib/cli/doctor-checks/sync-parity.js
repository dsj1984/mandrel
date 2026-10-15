// lib/cli/doctor-checks/sync-parity.js — Doctor checks: commands-in-sync, agents-in-sync.

import fs from 'node:fs';
import path from 'node:path';
import { isCommandExcluded } from '../../../.agents/scripts/lib/command-header.js';
import { getDeliveryRouting } from '../../../.agents/scripts/lib/config/delivery-routing.js';
import { readJsonSafe } from './read-json.js';

// check: commands-in-sync

/**
 * Parity of `.claude/commands/*.md` against the union of `.agents/workflows/`
 * and `.agents/local/workflows/`. A basename is expected iff at least one
 * source copy is not `command: false`, mirroring the sync script's
 * payload-wins shadowing; an unreadable source counts as projected.
 *
 * The root defaults to `process.cwd()`, never `resolveProjectRoot()` — that
 * lands on `node_modules/mandrel/` in an installed consumer, where the
 * command tree never exists, producing a permanent false "not synced".
 *
 * @param {{ projectRoot?: string, cwd?: () => string, readDir?: (dir: string) => string[], readFile?: (file: string) => string | null }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runCommandsInSync({
  projectRoot,
  cwd,
  readDir,
  readFile,
} = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const root = projectRoot ?? getCwd();
  const listDir =
    readDir ??
    ((dir) => {
      try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        return [];
      }
    });
  const readSource =
    readFile ??
    ((file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    });

  const srcDirs = [
    path.join(root, '.agents', 'workflows'),
    path.join(root, '.agents', 'local', 'workflows'),
  ];
  const destDir = path.join(root, '.claude', 'commands');

  // Top-level .md only (helpers/ are included modules, not commands).
  const expected = new Set();
  for (const srcDir of srcDirs) {
    for (const f of listDir(srcDir)) {
      if (f.startsWith('.')) continue;
      const content = readSource(path.join(srcDir, f));
      if (content != null && isCommandExcluded(content)) continue;
      expected.add(f);
    }
  }
  const sources = [...expected].sort();
  const dests = listDir(destDir)
    .filter((f) => !f.startsWith('.'))
    .sort();

  const dstSet = new Set(dests);
  const missing = sources.filter((f) => !dstSet.has(f));
  const extra = dests.filter((f) => !expected.has(f));

  if (missing.length === 0 && extra.length === 0) {
    return { ok: true, detail: `${sources.length} commands up to date` };
  }

  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} not synced`);
  if (extra.length > 0) parts.push(`${extra.length} stale`);
  return {
    ok: false,
    detail: parts.join(', '),
    remedy:
      'Run `npm run sync:commands` to regenerate the `.claude/commands/` tree.',
  };
}

// check: agents-in-sync

/**
 * Resolve `delivery.routing.roleScopedAgents` without `resolveConfig()`,
 * which pulls in AJV and would break the built-ins-only contract. Shallow-
 * merges only `delivery.routing` from `.agentrc.json` and
 * `.agentrc.local.json` (local wins).
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {boolean}
 */
function resolveRoleScopedAgentsFlag(projectRoot, fsImpl) {
  const base = readJsonSafe(path.join(projectRoot, '.agentrc.json'), fsImpl);
  const local = readJsonSafe(
    path.join(projectRoot, '.agentrc.local.json'),
    fsImpl,
  );
  const merged = {
    delivery: {
      routing: {
        ...(base?.delivery?.routing ?? {}),
        ...(local?.delivery?.routing ?? {}),
      },
    },
  };
  return getDeliveryRouting(merged).roleScopedAgents;
}

/**
 * Parity of `.claude/agents/*.md` against `.agents/agents/*.md` (root anchored
 * at `process.cwd()` as in `commands-in-sync`). A never-materialized tree is
 * fatal while `roleScopedAgents` is on — the acceptance critic would silently
 * fail to spawn and fall back to a weaker inline critic — and advisory when it
 * is off. Drift in a materialized tree always fails.
 *
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   readDir?: (dir: string) => string[],
 *   fsImpl?: typeof fs,
 *   roleScopedAgents?: boolean,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runAgentsInSync({
  projectRoot,
  cwd,
  readDir,
  fsImpl = fs,
  roleScopedAgents,
} = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const root = projectRoot ?? getCwd();
  const listDir =
    readDir ??
    ((dir) => {
      try {
        return fsImpl.readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        return [];
      }
    });

  const srcDir = path.join(root, '.agents', 'agents');
  const destDir = path.join(root, '.claude', 'agents');

  const sources = listDir(srcDir)
    .filter((f) => !f.startsWith('.'))
    .sort();
  const dests = listDir(destDir)
    .filter((f) => !f.startsWith('.'))
    .sort();

  if (dests.length === 0) {
    if (sources.length === 0) {
      return { ok: true, detail: '0 agents up to date' };
    }
    const resolvedFlag =
      typeof roleScopedAgents === 'boolean'
        ? roleScopedAgents
        : resolveRoleScopedAgentsFlag(root, fsImpl);
    if (!resolvedFlag) {
      return {
        ok: true,
        detail: `${sources.length} agent def(s) not materialized (roleScopedAgents is disabled)`,
      };
    }
    return {
      ok: false,
      detail: `${sources.length} agent def(s) not yet materialized in .claude/agents/`,
      remedy:
        'Run `mandrel sync-agents` to regenerate the `.claude/agents/` tree.',
    };
  }

  const srcSet = new Set(sources);
  const dstSet = new Set(dests);
  const missing = sources.filter((f) => !dstSet.has(f));
  const extra = dests.filter((f) => !srcSet.has(f));

  if (missing.length === 0 && extra.length === 0) {
    return { ok: true, detail: `${sources.length} agents up to date` };
  }

  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} not synced`);
  if (extra.length > 0) parts.push(`${extra.length} stale`);
  return {
    ok: false,
    detail: parts.join(', '),
    remedy:
      'Run `mandrel sync-agents` to regenerate the `.claude/agents/` tree.',
  };
}
