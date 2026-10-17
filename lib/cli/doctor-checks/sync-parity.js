// lib/cli/doctor-checks/sync-parity.js — Doctor checks: commands-in-sync, agents-in-sync.

import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_AGENTS_DIR,
  expectedClaudeAgents,
  listGeneratedClaudeAgents,
} from '../../../.agents/scripts/lib/claude/agents-projection.js';
import {
  CLAUDE_COMMANDS_DIR,
  expectedClaudeCommands,
  listGeneratedClaudeCommands,
} from '../../../.agents/scripts/lib/claude/commands-projection.js';
import { getDeliveryRouting } from '../../../.agents/scripts/lib/config/delivery-routing.js';
import { projectionParity, readTextOrNull } from './codex.js';
import { readJsonSafe } from './read-json.js';

const COMMANDS_REMEDY =
  'Run `npm run sync:commands` to regenerate the `.claude/commands/` tree.';
const AGENTS_REMEDY =
  'Run `mandrel sync-agents` to regenerate the `.claude/agents/` tree.';

// check: commands-in-sync

/**
 * Parity of `.claude/commands/` against what the command projection would
 * write now — byte-for-byte, so a same-name file with stale content fails as
 * well as a missing or extra one.
 *
 * The root defaults to `process.cwd()`, never `resolveProjectRoot()` — that
 * lands on `node_modules/mandrel/` in an installed consumer, where the
 * command tree never exists, producing a permanent false "not synced".
 *
 * @param {{ projectRoot?: string, cwd?: () => string }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runCommandsInSync({ projectRoot, cwd } = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const destDir = path.join(root, ...CLAUDE_COMMANDS_DIR.split('/'));
  return projectionParity({
    expected: () => expectedClaudeCommands({ projectRoot: root }),
    onDisk: listGeneratedClaudeCommands(destDir),
    readEntry: (rel) => readTextOrNull(path.join(destDir, rel)),
    noun: 'commands',
    where: `${CLAUDE_COMMANDS_DIR}/`,
    remedy: COMMANDS_REMEDY,
  });
}

// check: agents-in-sync

/**
 * Resolve `delivery.routing.roleScopedAgents` without `resolveConfig()`,
 * which pulls in AJV and would break the built-ins-only contract. Shallow-
 * merges only `delivery.routing` from `.agentrc.json` and
 * `.agentrc.local.json` (local wins).
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
function resolveRoleScopedAgentsFlag(projectRoot) {
  const base = readJsonSafe(path.join(projectRoot, '.agentrc.json'), fs);
  const local = readJsonSafe(path.join(projectRoot, '.agentrc.local.json'), fs);
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
 * Parity of `.claude/agents/` against what the agent projection would write
 * now (root anchored at `process.cwd()` as in `commands-in-sync`),
 * byte-for-byte. A never-materialized tree is fatal while `roleScopedAgents`
 * is on — the acceptance critic would silently fail to spawn and fall back to
 * a weaker inline critic — and advisory when it is off. Drift in a
 * materialized tree always fails.
 *
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   roleScopedAgents?: boolean,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runAgentsInSync({ projectRoot, cwd, roleScopedAgents } = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const destDir = path.join(root, ...CLAUDE_AGENTS_DIR.split('/'));
  const onDisk = listGeneratedClaudeAgents(destDir);
  const expected = () => expectedClaudeAgents({ projectRoot: root });

  if (onDisk.length === 0) {
    let size;
    try {
      size = expected().size;
    } catch (err) {
      return { ok: false, detail: err.message, remedy: AGENTS_REMEDY };
    }
    if (size === 0) return { ok: true, detail: '0 agents up to date' };
    const resolvedFlag =
      typeof roleScopedAgents === 'boolean'
        ? roleScopedAgents
        : resolveRoleScopedAgentsFlag(root);
    if (!resolvedFlag) {
      return {
        ok: true,
        detail: `${size} agent def(s) not materialized (roleScopedAgents is disabled)`,
      };
    }
    return {
      ok: false,
      detail: `${size} agent def(s) not yet materialized in .claude/agents/`,
      remedy: AGENTS_REMEDY,
    };
  }

  return projectionParity({
    expected,
    onDisk,
    readEntry: (name) => readTextOrNull(path.join(destDir, name)),
    noun: 'agents',
    where: `${CLAUDE_AGENTS_DIR}/`,
    remedy: AGENTS_REMEDY,
  });
}
