#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * select-audits.js — CLI + SDK for audit selection.
 *
 * Successor to the retired agent-protocols MCP tools. See ADR 20260424-702a in docs/decisions.md for the migration table.
 *
 * The pure rule-matching logic (matchesFilePattern, matchesAnyFilePattern,
 * selectAudits) lives here.
 *
 * Usage:
 *   node .agents/scripts/select-audits.js \
 *     --ticket <id> --gate <gate> [--base-branch main]
 *
 * Output: a single JSON object on stdout matching the MCP envelope:
 *   { selectedAudits, ticketId, gate, context: { changedFilesCount, ticketTitle } }
 *
 * Exit codes:
 *   0 — selection succeeded
 *   non-zero — validation or provider failure (error on stderr)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import picomatch from 'picomatch';
import { runAsCli } from './lib/cli-utils.js';
import {
  getPaths,
  PROJECT_ROOT,
  resolveConfig,
} from './lib/config-resolver.js';
import { isDegraded, softFailOrThrow } from './lib/degraded-mode.js';
import { gitSpawn } from './lib/git-utils.js';
import { createProvider } from './lib/provider-factory.js';
import { withTimeout } from './lib/util/with-timeout.js';

const DEFAULT_GIT_TIMEOUT_MS = 30000;

const HELP = `Usage: node .agents/scripts/select-audits.js \\
  --ticket <id> --gate <gate> [--base-branch main]

Flags:
  --ticket       GitHub issue number to evaluate (required).
  --gate         Audit gate (e.g. gate1, gate2, gate3, gate4) (required).
  --base-branch  Branch to diff against for changed-file matching (default: main).
  --help         Show this message.
`;

/**
 * Test a single filename against a single glob pattern using the project's
 * configured matcher semantics (`picomatch` with `dot: true`). Exported so
 * regression tests can pin engine behaviour without stubbing audit-rules.
 */
export function matchesFilePattern(pattern, file) {
  return picomatch(pattern, { dot: true })(file);
}

/**
 * Return true when any of `files` matches any of `patterns`.
 * Same semantics as `matchesFilePattern`; matchers are compiled once per call.
 */
export function matchesAnyFilePattern(patterns, files) {
  if (!patterns?.length || !files?.length) return false;
  const matchers = patterns.map((p) => picomatch(p, { dot: true }));
  return files.some((file) => matchers.some((m) => m(file)));
}

/**
 * Filter audits based on logic in audit-rules.json (validated against
 * audit-rules.schema.json).
 *
 * @param {object} params
 * @param {number} params.ticketId
 * @param {string} params.gate
 * @param {import('./lib/ITicketingProvider.js').ITicketingProvider} params.provider
 * @param {string} [params.baseBranch]
 * @param {(cwd: string, ...args: string[]) => Promise<{status:number, stdout:string, stderr:string}>} [params.injectedGitSpawn]
 *   Test-only seam. Production callers leave unset; the real (synchronous) `gitSpawn`
 *   is wrapped in `Promise.resolve` so `withTimeout` can still race it. Tests can
 *   inject a promise that never resolves to exercise the ETIMEDOUT fallback.
 * @param {number} [params.gitTimeoutMsOverride]
 *   Test-only seam to shrink the git-spawn timeout below the configured default
 *   (which is 30_000 ms) so timeout tests don't stall the suite.
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [params.gateModeOpts]
 *   Test-only seam to drive the `--gate-mode` / `AGENT_PROTOCOLS_GATE_MODE=1`
 *   detection; production callers leave unset and `isGateMode` reads
 *   `process.argv` / `process.env`.
 *
 * Returns either the success envelope (`{ selectedAudits, ticketId, gate, context }`)
 * OR the degraded envelope (`{ ok: false, degraded: true, reason, detail }`)
 * when the git-diff probe times out and gate-mode is unset. In gate-mode,
 * the same condition throws.
 */
export async function selectAudits({
  ticketId,
  gate,
  provider,
  baseBranch = 'main',
  injectedGitSpawn,
  gitTimeoutMsOverride,
  gateModeOpts,
}) {
  const { settings } = resolveConfig();
  const timeoutMs = gitTimeoutMsOverride ?? DEFAULT_GIT_TIMEOUT_MS;

  const rulesPath = path.join(
    PROJECT_ROOT,
    getPaths({ agentSettings: settings }).schemasRoot,
    'audit-rules.json',
  );
  let rulesData;
  try {
    rulesData = JSON.parse(await fs.readFile(rulesPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Failed to read audit-rules from ${rulesPath}: ${err.message}`,
    );
  }

  const ticket = await provider.getTicket(ticketId);
  const contentToSearch =
    `${ticket.title || ''} ${ticket.body || ''}`.toLowerCase();

  const runGit = injectedGitSpawn ?? (async (...args) => gitSpawn(...args));

  let changedFiles = [];
  try {
    const diff = await withTimeout(
      runGit(process.cwd(), 'diff', '--name-only', `${baseBranch}...HEAD`),
      timeoutMs,
      { label: 'select-audits git diff' },
    );
    if (diff?.status === 0) {
      changedFiles = diff.stdout
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    }
  } catch (err) {
    if (err?.code === 'ETIMEDOUT') {
      // Soft-fail contract (Tech Spec #819): in default mode, return a
      // degraded envelope so the caller sees the explicit signal instead of
      // silently falling through to keyword-only matching. In gate-mode,
      // hard-fail closed.
      return softFailOrThrow(
        'GIT_DIFF_TIMEOUT',
        `select-audits: git diff against ${baseBranch} timed out after ${timeoutMs} ms`,
        gateModeOpts,
      );
    }
    throw err;
  }

  const selectedAudits = [];

  for (const [auditName, ruleOpts] of Object.entries(rulesData.audits || {})) {
    const triggers = ruleOpts.triggers || {};

    const gateMatch = triggers.gates?.includes(gate);
    if (!gateMatch) continue;

    if (triggers.alwaysRun) {
      selectedAudits.push(auditName);
      continue;
    }

    const keywords = triggers.keywords || [];
    let keywordMatch = false;
    for (const kw of keywords) {
      if (contentToSearch.includes(kw.toLowerCase())) {
        keywordMatch = true;
        break;
      }
    }

    const fileMatch = matchesAnyFilePattern(
      triggers.filePatterns || [],
      changedFiles,
    );

    if (keywordMatch || fileMatch) {
      selectedAudits.push(auditName);
    }
  }

  return {
    selectedAudits,
    ticketId,
    gate,
    context: {
      changedFilesCount: changedFiles.length,
      ticketTitle: ticket.title,
    },
  };
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ticket: { type: 'string' },
      gate: { type: 'string' },
      'base-branch': { type: 'string' },
      'gate-mode': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseCliArgs(argv);

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const ticketId = Number.parseInt(values.ticket ?? '', 10);
  const gate = values.gate;

  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    process.stderr.write(`[select-audits] --ticket <id> is required.\n${HELP}`);
    process.exit(2);
  }
  if (!gate) {
    process.stderr.write(`[select-audits] --gate <gate> is required.\n${HELP}`);
    process.exit(2);
  }

  const baseBranch = values['base-branch'] ?? 'main';
  const { orchestration } = resolveConfig();
  const provider = createProvider(orchestration);

  const gateModeOpts = {
    argv: values['gate-mode'] ? ['--gate-mode'] : [],
    env: process.env,
  };
  const result = await selectAudits({
    ticketId,
    gate,
    provider,
    baseBranch,
    gateModeOpts,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (isDegraded(result)) {
    // Structured-degraded contract: print the envelope to stdout (above) so
    // callers can parse `degraded: true`, then exit non-zero so shell-level
    // pipelines also see the soft-fail. Gate-mode never reaches here — it
    // throws instead, and runAsCli's default handler exits 1.
    process.exit(1);
  }
}

runAsCli(import.meta.url, main, { source: 'select-audits' });
