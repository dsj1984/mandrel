// lib/cli/doctor-checks/llm-review.js — Doctor check: llm-review-provider.

import fs from 'node:fs';
import path from 'node:path';
import { applyLocalOverlay } from '../../../.agents/scripts/lib/config/agentrc-overlay.js';
import { DEFAULT_REVIEW_PROVIDERS } from '../../../.agents/scripts/lib/config/review-chain-default.js';
import { readJsonSafe } from './read-json.js';
import { spawn } from './spawn.js';

/**
 * The CLIs each inline provider can run on, in preference order. Mirrors
 * the review-provider registry without importing it (built-ins only).
 */
const PROVIDER_CLIS = Object.freeze({
  'code-review': ['claude'],
  'security-review': ['claude'],
  codex: ['codex'],
  'llm-review': ['claude', 'codex'],
});

const NATIVE_ONLY_ADVISORY =
  'close runs native only — install claude or codex, or pin codeReview.providers';

/**
 * `delivery.codeReview.providers` from `.agentrc.json` with
 * `.agentrc.local.json` merged over it; unset or empty is the default chain.
 *
 * @param {string} projectRoot
 * @param {{ readFileSync: Function }} fsImpl
 * @returns {{ entries: ReadonlyArray<object>, pinned: boolean }}
 */
function readReviewChain(projectRoot, fsImpl) {
  const committed =
    readJsonSafe(path.join(projectRoot, '.agentrc.json'), fsImpl) ?? {};
  let effective = committed;
  try {
    effective = applyLocalOverlay({ fsImpl, projectRoot, committed }).effective;
  } catch {
    // An unparseable overlay is the config check's to report.
  }
  const providers = effective?.delivery?.codeReview?.providers;
  return Array.isArray(providers) && providers.length > 0
    ? { entries: providers, pinned: true }
    : { entries: DEFAULT_REVIEW_PROVIDERS, pinned: false };
}

/**
 * Which CLI will serve each LLM provider in the effective review chain.
 * Fails only for a pinned non-optional provider whose CLI is missing — the
 * same hard failure close would hit at construction.
 *
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   runner?: (cmd: string, args: string[], opts?: object) => { status: number|null },
 *   fsImpl?: { readFileSync: Function, existsSync: Function },
 *   platform?: string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runLlmReviewProvider({
  projectRoot,
  cwd,
  runner = spawn,
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  const root = projectRoot ?? (cwd ?? (() => process.cwd()))();
  const { entries, pinned } = readReviewChain(root, fsImpl);
  const seen = new Map();
  const onPath = (cli) => {
    if (!seen.has(cli)) {
      const r = runner(cli, ['--version'], {
        shell: platform === 'win32',
        timeout: 5000,
      });
      seen.set(cli, r?.status === 0);
    }
    return seen.get(cli);
  };

  const served = [];
  const missing = [];
  for (const entry of entries) {
    const clis = entry?.manualPrompt ? null : PROVIDER_CLIS[entry?.name];
    if (!clis) continue;
    const cli = clis.find(onPath);
    if (cli) served.push(`${entry.name} via ${cli}`);
    else if (entry.optional !== true) missing.push(entry.name);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      detail: `codeReview.providers pins ${missing.join(', ')} without optional: true, but its CLI is not on PATH — close would fail at review`,
      remedy:
        'Install the missing CLI (`claude` or `codex`), mark the entry `optional: true`, or remove it from codeReview.providers.',
    };
  }
  if (served.length === 0) {
    return {
      ok: true,
      detail: pinned
        ? 'the pinned codeReview.providers chain runs no LLM review on this host'
        : NATIVE_ONLY_ADVISORY,
    };
  }
  return {
    ok: true,
    detail: `${pinned ? 'pinned' : 'default'} chain reviews with ${served.join(', ')}`,
  };
}
