// lib/cli/doctor-checks/session-title-allowlist.js — Doctor check: session-title-allowlist.

import fs from 'node:fs';
import path from 'node:path';
import { getDeliveryRouting } from '../../../.agents/scripts/lib/config/delivery-routing.js';
import { readEffectiveAgentrc } from './effective-agentrc.js';

export const SESSION_TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title';
const COVERING = new Set([
  SESSION_TITLE_TOOL,
  'mcp__ccd_session_mgmt__*',
  'mcp__ccd_session_mgmt',
]);
const SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'];

/**
 * Advisory: with session titles on, does a Claude Code settings file allow the
 * desktop app's rename tool, so a rename needs no permission prompt? Never fails.
 *
 * @param {{ projectRoot?: string, cwd?: () => string, fsImpl?: { readFileSync: Function, existsSync: Function } }} [opts]
 * @returns {Promise<{ ok: true, detail: string }>}
 */
export async function runSessionTitleAllowlist({
  projectRoot,
  cwd,
  fsImpl = fs,
} = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const agentrc = readEffectiveAgentrc(root, fsImpl);
  if (!getDeliveryRouting(agentrc).sessionTitles) {
    return { ok: true, detail: 'session titles are off; nothing to check' };
  }
  const present = SETTINGS.filter((rel) =>
    fsImpl.existsSync(path.join(root, rel)),
  );
  if (present.length === 0) {
    return {
      ok: true,
      detail: 'no Claude Code settings file found; nothing to check',
    };
  }
  const malformed = [];
  for (const rel of present) {
    let allow;
    try {
      allow = JSON.parse(fsImpl.readFileSync(path.join(root, rel), 'utf8'))
        ?.permissions?.allow;
    } catch {
      malformed.push(rel);
      continue;
    }
    if (Array.isArray(allow) && allow.some((entry) => COVERING.has(entry))) {
      return {
        ok: true,
        detail: `${rel} allows ${SESSION_TITLE_TOOL}; session renames need no prompt`,
      };
    }
  }
  const unreadable = malformed.length
    ? ` (${malformed.join(', ')} is not valid JSON)`
    : '';
  return {
    ok: true,
    detail: `session titles are on but no settings file allows the rename tool${unreadable} — add "${SESSION_TITLE_TOOL}" to permissions.allow in .claude/settings.json`,
  };
}
