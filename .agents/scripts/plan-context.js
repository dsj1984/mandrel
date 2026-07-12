#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * plan-context.js — step 1 of the collapsed `/plan` pipeline (Epic #4474,
 * M3 PR2): the single emit-context CLI.
 *
 * Folds the retired 12-phase pipeline's two emit-context halves plus
 * the three previously-no-CLI library calls
 * (`findSimilarOpenEpics`, clarity scoring, re-plan detection) into ONE
 * stdout-pure JSON envelope. The PR7 cutover retired the delegate CLIs —
 * this is the only emit-context surface.
 *
 * Two entry forms (exactly one is required):
 *
 *   --epic <id>          Existing-Epic mode. Envelope carries `epic`,
 *                        `clarity` (Epic Clarity Gate rubric), `replan`
 *                        (already-planned signals) and `planState`.
 *
 *   --one-pager <path>   Ideation mode — the Epic does not exist yet
 *                        (creation moves to the persist half). Envelope
 *                        carries `onePager` and `duplicates[]` (cross-Epic
 *                        dup search). No clarity score: the ideation path
 *                        is definitionally clear.
 *
 * Flags:
 *   --pretty         Pretty-print the JSON envelope.
 *   --full-context   Bypass the planning-context budget (unbounded body).
 *
 * stdout is reserved for the JSON envelope (Story #2278 discipline):
 * `routeAllOutputToStderr()` runs before any pipeline code so a captured
 * file is unconditionally parseable by `JSON.parse`.
 *
 * Exit codes:
 *   0 — envelope emitted.
 *   1 — fatal error (see stderr).
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { routeAllOutputToStderr } from './lib/Logger.js';
import { buildPlanContext } from './lib/orchestration/plan-context.js';
import { recordPlanInvocation } from './lib/orchestration/plan-metrics.js';
import { createProvider } from './lib/provider-factory.js';

/**
 * Build the envelope and write it to `stdout` as a single JSON line
 * (or pretty-printed with --pretty). Exported for tests: the stdout-purity
 * test injects a fake provider and a capture stream and asserts the
 * captured output is exactly one `JSON.parse`-able payload.
 *
 * @param {{
 *   mode: 'epic'|'one-pager',
 *   epicId?: number,
 *   onePagerPath?: string,
 *   onePagerContent?: string,
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   fullContext?: boolean,
 *   pretty?: boolean,
 *   cwd?: string,
 *   stdout?: { write: (chunk: string) => void },
 * }} args
 * @returns {Promise<object>} the emitted envelope.
 */
export async function emitPlanContext({
  mode,
  epicId,
  onePagerPath,
  onePagerContent,
  provider,
  config,
  settings,
  fullContext = false,
  pretty = false,
  cwd,
  stdout = process.stdout,
}) {
  const envelope = await buildPlanContext({
    mode,
    epicId,
    onePagerPath,
    onePagerContent,
    provider,
    config,
    settings,
    fullContext,
    cwd,
  });
  const json = pretty
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify(envelope);
  stdout.write(`${json}\n`);
  return envelope;
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'one-pager': { type: 'string' },
      pretty: { type: 'boolean', default: false },
      'full-context': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const hasEpic = typeof values.epic === 'string' && values.epic.length > 0;
  const hasOnePager =
    typeof values['one-pager'] === 'string' && values['one-pager'].length > 0;
  if (hasEpic === hasOnePager) {
    throw new Error(
      'Pass exactly one of --epic <id> or --one-pager <path>. ' +
        '(--epic: existing-Epic mode; --one-pager: ideation mode.)',
    );
  }

  let epicId;
  if (hasEpic) {
    epicId = Number.parseInt(values.epic, 10);
    if (!Number.isInteger(epicId)) {
      throw new Error(
        `--epic must be a numeric issue id (got "${values.epic}").`,
      );
    }
  }

  // stdout is reserved for the JSON envelope: flip every Logger sink that
  // could land on stdout to stderr BEFORE any pipeline code runs
  // (Story #2278 — the same stdout-purity guarantee the retired pipeline
  // gives; this CLI is emit-only so the flip is unconditional).
  routeAllOutputToStderr();

  let config;
  let settings;
  try {
    config = resolveConfig();
    // `settings` retains the legacy bag shape `buildAuthoringContext` and
    // friends consume: `{ baseBranch, paths, planning, docsContextFiles }`.
    settings = {
      baseBranch: config.project?.baseBranch,
      paths: config.project?.paths,
      planning: config.planning,
      docsContextFiles: config.project?.docsContextFiles,
    };
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  const provider = createProvider(config);

  // Plan-metrics ledger (#4474 PR1): stamp entry/exit + mode so the folded
  // emit surface is measured against the 12-phase baseline. One-pager mode
  // has no Epic yet, so the record routes to the standalone stream
  // (epicId null) exactly like `story-plan.js`.
  await recordPlanInvocation(
    {
      cli: 'plan-context',
      mode: hasEpic ? 'epic' : 'one-pager',
      epicId: hasEpic ? epicId : null,
      config,
    },
    () =>
      emitPlanContext({
        mode: hasEpic ? 'epic' : 'one-pager',
        epicId,
        onePagerPath: hasOnePager ? values['one-pager'] : undefined,
        provider,
        config,
        settings,
        fullContext: values['full-context'],
        pretty: values.pretty,
      }),
  );
}

runAsCli(import.meta.url, main, { source: 'plan-context' });
