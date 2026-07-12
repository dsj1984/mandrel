#!/usr/bin/env node

/**
 * plan-critics.js — deterministic dispatch gate for the conditional
 * author-step critics of the collapsed /plan flow (Epic #4474 PR6,
 * design §4).
 *
 * Runs between authoring and gate #2, entirely git-local (zero GitHub
 * calls): reads the authored artifacts, evaluates the risk/size dispatch
 * conditions for the consolidation (8.3) and pre-mortem (8.5) critics via
 * `lib/orchestration/plan-critic-conditions.js`, and emits one JSON
 * verdict on stdout. The workflow dispatches a fresh-context sub-agent
 * ONLY for critics with `dispatch: true`; every skip decision is appended
 * to the plan-metrics ledger (`kind: "critic-skip"`, with reasons) so
 * under-firing is auditable — the persist validators remain unchanged
 * hard gates regardless of what this gate decides.
 *
 * Conditions (design §4 / §6 PR6):
 *   - Consolidation: the existing deterministic precondition
 *     (`evaluateConsolidationPrecondition`) says dispatch AND (the draft
 *     has > 5 stories OR a confirmed divergence from the Tech Spec's
 *     Delivery Slicing table). Skipped outright in the single-delivery
 *     shape (no tickets exist to consolidate).
 *   - Pre-mortem: risk verdict overall level is high, OR ticket count is
 *     at least half `maxTickets`, OR any `planning.riskHeuristics` phrase
 *     matches the plan text (case-insensitive substring over tech spec +
 *     tickets + risk summary).
 *
 * Modes:
 *   --epic <id>          Artifact paths default to the per-Epic temp tree
 *                        (`temp/epic-<id>/techspec.md`, `risk-verdict.json`,
 *                        `tickets.json`); skip records land on the
 *                        per-Epic plan-metrics ledger.
 *   explicit paths       Ideation mode: pass --tech-spec/--risk-verdict
 *                        (and --tickets when fan-out) explicitly; skip
 *                        records land on the standalone ledger stream.
 *
 * Output (stdout-pure JSON):
 *   { epicId, consolidation: { critic, dispatch, reasons },
 *     premortem: { critic, dispatch, reasons } }
 *
 * Exit codes: 0 — verdict emitted (dispatch decisions are data, not
 * failures); 1 — fatal error (unreadable/invalid artifacts, bad args).
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { epicArtifactPath } from './lib/config/temp-paths.js';
import {
  getLimits,
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { routeAllOutputToStderr } from './lib/Logger.js';
import { loadRiskVerdict } from './lib/orchestration/epic-plan-spec/phases/risk-verdict.js';
import {
  evaluateConsolidationDispatch,
  evaluatePremortemDispatch,
} from './lib/orchestration/plan-critic-conditions.js';
import {
  appendCriticSkip,
  recordPlanInvocation,
} from './lib/orchestration/plan-metrics.js';

const USAGE =
  'Usage: plan-critics.js (--epic <EpicId> | --tech-spec <file> ' +
  '--risk-verdict <file> [--tickets <file>]) [--pretty]';

/**
 * Resolve the planning risk heuristics list from the canonical config
 * block (same resolution `plan-context.js` and the decompose context use).
 *
 * @param {object} config
 * @returns {string[]}
 */
function resolveRiskHeuristics(config = {}) {
  if (Array.isArray(config.planning?.riskHeuristics)) {
    return config.planning.riskHeuristics;
  }
  return config.agentSettings?.planning?.riskHeuristics || [];
}

async function readOptional(filePath, { required }) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (!required && err?.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'tech-spec': { type: 'string' },
      'risk-verdict': { type: 'string' },
      tickets: { type: 'string' },
      pretty: { type: 'boolean', default: false },
    },
    strict: true,
  });

  let epicId = null;
  if (values.epic !== undefined) {
    epicId = Number.parseInt(values.epic, 10);
    if (!Number.isInteger(epicId)) {
      throw new Error(
        `--epic must be a numeric issue id (got "${values.epic}").\n${USAGE}`,
      );
    }
  }

  // stdout is reserved for the JSON verdict — flip every Logger sink to
  // stderr before any pipeline code runs (same guarantee plan-context.js
  // gives its envelope).
  routeAllOutputToStderr();

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }

  const fallback = (basename) =>
    epicId === null ? undefined : epicArtifactPath(epicId, basename, config);
  const techSpecPath = values['tech-spec'] ?? fallback('techspec.md');
  const riskVerdictPath =
    values['risk-verdict'] ?? fallback('risk-verdict.json');
  const ticketsPath = values.tickets ?? fallback('tickets.json');
  if (!techSpecPath || !riskVerdictPath) {
    throw new Error(
      `Missing artifact path(s): without --epic, explicit --tech-spec and --risk-verdict are required.\n${USAGE}`,
    );
  }

  const verdict = await recordPlanInvocation(
    { cli: 'plan-critics', mode: 'evaluate', epicId, config },
    async () => {
      const techSpecContent = await readOptional(techSpecPath, {
        required: true,
      });
      const riskVerdict = loadRiskVerdict(riskVerdictPath);
      // Tickets are shape-dependent: a single-delivery plan authors none.
      // Required only when passed explicitly.
      const ticketsRaw = ticketsPath
        ? await readOptional(ticketsPath, {
            required: values.tickets !== undefined,
          })
        : null;
      let tickets = null;
      if (ticketsRaw !== null) {
        try {
          tickets = JSON.parse(ticketsRaw);
        } catch (err) {
          throw new Error(
            `Failed to parse tickets file "${ticketsPath}" as JSON: ${err.message}`,
          );
        }
        if (!Array.isArray(tickets)) {
          throw new Error(
            `Tickets file "${ticketsPath}" must contain a JSON array.`,
          );
        }
      }

      const consolidation =
        tickets === null
          ? {
              critic: 'consolidation',
              dispatch: false,
              reasons: [
                'single-delivery shape — no draft tickets exist to consolidate.',
              ],
            }
          : evaluateConsolidationDispatch({
              draftStories: tickets,
              specText: techSpecContent,
            });

      const premortem = evaluatePremortemDispatch({
        riskVerdict,
        ticketCount: tickets?.length ?? 0,
        maxTickets: getLimits(config).maxTickets,
        riskHeuristics: resolveRiskHeuristics(config),
        planText: [
          techSpecContent,
          ticketsRaw ?? '',
          riskVerdict.summary ?? '',
        ].join('\n'),
      });

      // Skip-audit trail (#4474 PR6): every non-dispatch is a ledger
      // record. Best-effort — a failed append never fails the gate.
      for (const decision of [consolidation, premortem]) {
        if (!decision.dispatch) {
          await appendCriticSkip(
            {
              critic: decision.critic,
              reasons: decision.reasons,
              cli: 'plan-critics',
              epicId,
            },
            config,
          );
        }
      }

      return { epicId, consolidation, premortem };
    },
  );

  const json = values.pretty
    ? JSON.stringify(verdict, null, 2)
    : JSON.stringify(verdict);
  process.stdout.write(`${json}\n`);
}

runAsCli(import.meta.url, main, { source: 'plan-critics' });
