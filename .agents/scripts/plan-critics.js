#!/usr/bin/env node

/**
 * plan-critics.js — the /plan critic-dispatch verdict CLI (Story #4592).
 *
 * `/plan` step 2.5 (between Author and Persist) runs this against the draft
 * `stories.json`. It evaluates the consolidation + pre-mortem dispatch
 * conditions and prints the verdict as JSON on stdout so the workflow can
 * act on it — dispatching a fresh-context critic sub-agent and folding its
 * findings into a re-author round **before** the plan is persisted.
 *
 * Why here and nowhere else. The evaluation used to run inside
 * `run-plan-persist.js`, after authoring was finished and immediately before
 * `createStoryIssues` — the one point in the flow where nothing can act on a
 * `dispatch: true` verdict, because the artifacts are about to become live
 * issues. It logged the verdict and moved on. This CLI is now the **single**
 * evaluation point, sited where a re-author loop actually exists.
 *
 * Advisory by contract: a `dispatch: true` verdict routes work to the
 * workflow, it does not gate the run. This CLI exits 0 on any verdict; only a
 * usage/IO error is a failure. Every `dispatch: false` decision is recorded to
 * the plan-metrics ledger (`appendCriticSkip`) so under-firing stays auditable.
 *
 * CLI:
 *   --stories <file>     Required. The draft Story ticket array (JSON).
 *   --tech-spec <file>   Optional. Shared Tech Spec carrying the
 *                        `## Delivery Slicing` table the consolidation
 *                        precondition reads.
 *
 * stdout is reserved for the verdict JSON (Story #2278 discipline):
 *
 *   {
 *     "consolidation": { "critic": "consolidation", "dispatch": false, "reasons": [...] },
 *     "premortem":     { "critic": "pre-mortem",    "dispatch": true,  "reasons": [...] },
 *     "textHygiene":   { "critic": "text-hygiene",  "findings": [...] }
 *   }
 *
 * `textHygiene` (Story #4599) is advisory-only: deterministic body lints with
 * no dispatch semantics — its findings fold into the re-author round.
 *
 * Human-readable log lines go to stderr, matching the sibling `plan-persist`.
 *
 * Exit codes: 0 success (any verdict); 1 usage/IO error.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { evaluatePlanCritics } from './lib/orchestration/plan-critics-evaluate.js';
import { appendCriticSkip } from './lib/orchestration/plan-metrics.js';

const CLI_OPTIONS = {
  stories: { type: 'string' },
  'tech-spec': { type: 'string' },
};

const USAGE = 'Usage: plan-critics.js --stories <file> [--tech-spec <file>]';

/** The `cli` discriminator every ledger record from this surface carries. */
export const PLAN_CRITICS_CLI = 'plan-critics';

/**
 * Read the draft artifacts the critics evaluate.
 *
 * @param {{ storiesPath: string, techSpecPath?: string|null }} paths
 * @returns {Promise<{ tickets: object[], techSpecContent: string }>}
 */
export async function loadCriticArtifacts({
  storiesPath,
  techSpecPath = null,
}) {
  const raw = await readFile(storiesPath, 'utf8');
  let tickets;
  try {
    tickets = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse stories file "${storiesPath}" as JSON: ${err.message}`,
    );
  }
  if (!Array.isArray(tickets)) {
    throw new Error(`Stories file "${storiesPath}" must contain a JSON array.`);
  }
  const techSpecContent = techSpecPath
    ? await readFile(techSpecPath, 'utf8')
    : '';
  return { tickets, techSpecContent };
}

/**
 * Log each decision and record every skip on the plan-metrics ledger. The
 * ledger write is best-effort by `appendCriticSkip`'s own contract — it can
 * never fail the plan step.
 *
 * @param {{ consolidation: object, premortem: object, textHygiene?: object }} verdict
 * @param {object} config
 * @param {{ append?: typeof appendCriticSkip }} [deps]
 * @returns {Promise<void>}
 */
export async function recordCriticSkips(
  verdict,
  config,
  { append = appendCriticSkip } = {},
) {
  for (const decision of [verdict.consolidation, verdict.premortem]) {
    Logger.info(
      `[plan-critics] critic ${decision.critic}: ` +
        `${decision.dispatch ? 'dispatch' : 'skip'} — ` +
        decision.reasons.join('; '),
    );
    if (!decision.dispatch) {
      await append(
        {
          critic: decision.critic,
          reasons: decision.reasons,
          cli: PLAN_CRITICS_CLI,
        },
        config,
      );
    }
  }

  // Text hygiene (Story #4599) is advisory-only — no dispatch semantics, so
  // "skip" here means "zero findings". Recording that keeps the lint's
  // fire/skip accounting on the same ledger as the dispatching critics.
  const hygiene = verdict.textHygiene;
  if (hygiene) {
    const count = hygiene.findings.length;
    Logger.info(
      `[plan-critics] critic ${hygiene.critic}: ${count} finding(s) (advisory).`,
    );
    if (count === 0) {
      await append(
        {
          critic: hygiene.critic,
          reasons: ['No text-hygiene findings over the draft stories.'],
          cli: PLAN_CRITICS_CLI,
        },
        config,
      );
    }
  }
}

/**
 * Load the artifacts, evaluate both critics, record the skips, and return the
 * verdict. Exported as the CLI's whole body so tests drive it in-process with
 * an explicit config and ledger seam.
 *
 * @param {{
 *   storiesPath: string,
 *   techSpecPath?: string|null,
 *   config?: object,
 *   append?: typeof appendCriticSkip,
 * }} args
 * @returns {Promise<{ consolidation: object, premortem: object, textHygiene: object }>}
 */
export async function evaluateCriticArtifacts({
  storiesPath,
  techSpecPath = null,
  config = {},
  append = appendCriticSkip,
}) {
  const { tickets, techSpecContent } = await loadCriticArtifacts({
    storiesPath,
    techSpecPath,
  });
  const verdict = evaluatePlanCritics({ techSpecContent, tickets, config });
  await recordCriticSkips(verdict, config, { append });
  return verdict;
}

async function main() {
  const { values } = parseArgs({ options: CLI_OPTIONS });

  if (!values.stories) {
    throw new Error(USAGE);
  }

  // stdout is reserved for the verdict JSON — flip every Logger sink that
  // could land on stdout to stderr before any evaluation runs.
  routeAllOutputToStderr();

  const verdict = await evaluateCriticArtifacts({
    storiesPath: path.resolve(values.stories),
    techSpecPath: values['tech-spec']
      ? path.resolve(values['tech-spec'])
      : null,
    config: resolveConfig(),
  });

  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'plan-critics',
  propagateExitCode: true,
});
