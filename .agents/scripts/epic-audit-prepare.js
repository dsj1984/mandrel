#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-audit-prepare.js — Phase 4 prepare CLI for `/epic-deliver`.
 *
 * Thin glue around the audit-suite `selectAudits` SDK. Reads the Epic
 * ticket, runs the change-set selector against the Epic branch diff
 * (`main..epic/<id>`), and emits a JSON envelope on stdout that the
 * inline `helpers/epic-audit.md` consumes.
 *
 * The CLI carries no business logic beyond:
 *   1. validating `--epic <id>`,
 *   2. resolving the Epic branch name (`epic/<id>`),
 *   3. running `selectAudits` at the close-gate (`gate3`),
 *   4. routing the model-judged risk envelope's high-risk axes onto their
 *      mapped audit lenses (Story #3889 — `resolveAuditLenses`) and unioning
 *      them into the change-set selection, and
 *   5. shaping the result into the helper-consumable envelope.
 *
 * Story #3889 — risk-routed lenses. Epic #3865 added `resolveAuditLenses`
 * (axis → audit-lens mapping for the model-judged risk verdict) to
 * `lib/orchestration/code-review.js` but nothing invoked it in the live
 * delivery path. This CLI now reads the `planningRisk` envelope off the
 * Epic's `epic-plan-state` checkpoint and unions the routed lenses into
 * `selectedAudits`, so a high-risk Epic auto-runs its mapped lenses
 * (e.g. a `security`-axis Epic runs `audit-security`) at Phase 4 through the
 * SAME `runAuditSuite` / `selectAuditStrategy` engine the helper already
 * dispatches — no new audit machinery. A low-risk Epic routes no extra
 * lenses. Reading the checkpoint is best-effort: a missing/unparseable
 * checkpoint degrades to the change-set selection alone (never an abort).
 *
 * Envelope shape (Tech Spec #2588 — API Changes § New CLI):
 *
 *   {
 *     "epicId": 2586,
 *     "epicBranch": "epic/2586",
 *     "selectedAudits": ["audit-security", "audit-privacy"],
 *     "changeSetAudits": ["audit-privacy"],
 *     "riskRoutedAudits": ["audit-security"],
 *     "changedFiles": ["src/api/admin/users.ts", "..."],
 *     "changedFilesCount": 47,
 *     "substitutionsPayload": "src/api/admin/users.ts\n..."
 *   }
 *
 * `selectedAudits` is the union the helper dispatches: the change-set
 * selection (`changeSetAudits`) plus the risk-routed lenses
 * (`riskRoutedAudits`), de-duplicated. The two source-of-truth arrays are
 * surfaced for observability so the operator can see why each lens fired.
 *
 * Usage:
 *   node .agents/scripts/epic-audit-prepare.js --epic <epicId> [--base-branch main]
 *
 * Exit codes:
 *   0 — envelope written to stdout
 *   2 — validation error (missing/invalid --epic)
 *   1 — provider / git failure
 */

import { selectAudits } from './lib/audit-suite/index.js';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { resolveAuditLenses } from './lib/orchestration/code-review.js';
import { read as readPlanState } from './lib/orchestration/epic-plan-state-store.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-audit-prepare.js --epic <epicId> [--base-branch main]

Flags:
  --epic         Epic ticket ID to prepare audit selection for (required).
  --base-branch  Branch to diff against for the selector's change-set
                 input (default: main).
  --gate         Audit gate label (default: gate3 — Epic close gate).
  --help         Show this message.
`;

const DEFAULT_GATE = 'gate3';

/**
 * Parse argv into the values bag this CLI understands.
 *
 * @param {string[]} argv
 * @returns {{ epic: number|null, 'base-branch': string, gate: string, help: boolean }}
 */
export function parseArgv(argv) {
  const { values } = defineFlags(
    {
      epic: { type: 'ticket', alias: 'epicId' },
      'base-branch': { type: 'string', default: 'main', alias: 'baseBranch' },
      gate: { type: 'string', default: DEFAULT_GATE },
      help: { type: 'boolean' },
    },
    argv,
  );
  return values;
}

/**
 * Resolve the risk-routed audit lenses for an Epic by reading the model-judged
 * `planningRisk` envelope off the Epic's `epic-plan-state` checkpoint and
 * mapping its high-risk axes onto audit lenses via `resolveAuditLenses`
 * (Story #3889). Best-effort: a missing/unparseable checkpoint, an absent
 * `planningRisk` field, or a provider read failure resolves to an empty array
 * so the change-set selection is never aborted by a risk-read failure.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   readPlanState?: typeof readPlanState,
 *   resolveAuditLenses?: typeof resolveAuditLenses,
 * }} params
 * @returns {Promise<string[]>} Ordered, de-duplicated risk-routed lens names.
 */
export async function resolveRiskRoutedLenses({
  epicId,
  provider,
  readPlanState: readPlanStateFn = readPlanState,
  resolveAuditLenses: resolveAuditLensesFn = resolveAuditLenses,
}) {
  let state = null;
  try {
    state = await readPlanStateFn({ provider, epicId });
  } catch {
    // A read failure (provider error, malformed comment) must not abort the
    // change-set audit. Degrade to "no risk-routed lenses".
    return [];
  }
  const planningRisk = state?.planningRisk;
  if (!planningRisk || !Array.isArray(planningRisk.axes)) return [];
  return resolveAuditLensesFn(planningRisk);
}

/**
 * Union two ordered lens lists, de-duplicating while preserving the order of
 * first appearance (change-set selection first, then risk-routed extras).
 *
 * @param {string[]} changeSetAudits
 * @param {string[]} riskRoutedAudits
 * @returns {string[]}
 */
function unionAudits(changeSetAudits, riskRoutedAudits) {
  const seen = new Set();
  const merged = [];
  for (const lens of [...changeSetAudits, ...riskRoutedAudits]) {
    if (typeof lens !== 'string' || lens.length === 0 || seen.has(lens)) {
      continue;
    }
    seen.add(lens);
    merged.push(lens);
  }
  return merged;
}

/**
 * Orchestration body. Exported as a sibling so tests can drive it
 * without spawning a child process. CLI surface unchanged.
 *
 * @param {{ epicId: number, baseBranch?: string, gate?: string, help?: boolean }} values
 * @param {{
 *   resolveConfig?: () => object,
 *   createProvider?: (config: object) => object,
 *   selectAudits?: typeof selectAudits,
 *   readPlanState?: typeof readPlanState,
 *   resolveAuditLenses?: typeof resolveAuditLenses,
 *   help?: string,
 * }} [deps]
 * @returns {Promise<{ exitCode: number, result: object }>}
 *   `result.kind` is one of `'help'`, `'validation-error'`, `'envelope'`.
 */
export async function runEpicAuditPrepare(values, deps = {}) {
  const helpText = deps.help ?? HELP;
  if (values.help) {
    return { exitCode: 0, result: { kind: 'help', text: helpText } };
  }

  const { epicId, baseBranch, gate } = values;

  if (!Number.isFinite(epicId) || epicId <= 0) {
    return {
      exitCode: 2,
      result: {
        kind: 'validation-error',
        message: '[epic-audit-prepare] --epic <id> is required.',
        help: helpText,
      },
    };
  }

  const cfg = deps.resolveConfig ? deps.resolveConfig() : resolveConfig();
  const provider = deps.createProvider
    ? deps.createProvider(cfg)
    : createProvider(cfg);
  const runner = deps.selectAudits ?? selectAudits;

  // Pin the change set to the requested Epic's own branch rather than the
  // shared checkout's HEAD (Story #3362). Under two concurrent /epic-deliver
  // runs sharing one working copy, a HEAD-relative diff silently reports the
  // *other* Epic's change set; `refs/heads/epic/<id>` is unambiguous.
  const epicBranch = `epic/${epicId}`;
  const epicRef = `refs/heads/${epicBranch}`;

  const envelope = await runner({
    ticketId: epicId,
    gate: gate ?? DEFAULT_GATE,
    provider,
    baseBranch,
    headRef: epicRef,
  });

  // Degraded envelopes from selectAudits short-circuit through the
  // same surface so callers can branch on `degraded: true`. The
  // helper treats a degraded envelope as a Phase 4 abort — propagate
  // it verbatim with a non-zero exit code so shell pipelines see the
  // failure. An unresolved Epic ref (HEAD_REF_UNRESOLVED) flows through
  // here too: better to abort Phase 4 than audit a phantom change set.
  if (envelope?.degraded) {
    return {
      exitCode: 1,
      result: {
        kind: 'envelope',
        envelope: {
          epicId,
          epicBranch,
          ...envelope,
        },
      },
    };
  }

  // Defence in depth: assert the selector diffed the ref we asked for. If a
  // future selector change drops the pin, fail closed with an explicit
  // degraded envelope rather than emitting an audit selection silently
  // derived from the wrong branch.
  const resolvedRef = envelope?.context?.resolvedRef;
  if (resolvedRef !== epicRef) {
    return {
      exitCode: 1,
      result: {
        kind: 'envelope',
        envelope: {
          epicId,
          epicBranch,
          ok: false,
          degraded: true,
          reason: 'EPIC_REF_MISMATCH',
          detail: `epic-audit-prepare: selector diffed '${resolvedRef ?? '(unset)'}' but Epic #${epicId} requested '${epicRef}'`,
        },
      },
    };
  }

  const changedFiles = envelope?.context?.changedFiles ?? [];
  const changeSetAudits = envelope?.selectedAudits ?? [];

  // Story #3889 — union the model-judged risk-routed lenses into the
  // change-set selection. Read off the Epic's epic-plan-state checkpoint
  // (best-effort; a read failure yields no extra lenses). A high-risk
  // `security` axis therefore fires `audit-security` even when the change
  // set alone did not select it; a low-risk Epic adds nothing.
  const riskRoutedAudits = await resolveRiskRoutedLenses({
    epicId,
    provider,
    readPlanState: deps.readPlanState,
    resolveAuditLenses: deps.resolveAuditLenses,
  });
  const selectedAudits = unionAudits(changeSetAudits, riskRoutedAudits);

  return {
    exitCode: 0,
    result: {
      kind: 'envelope',
      envelope: {
        epicId,
        epicBranch,
        selectedAudits,
        changeSetAudits,
        riskRoutedAudits,
        changedFiles,
        changedFilesCount: changedFiles.length,
        substitutionsPayload: changedFiles.join('\n'),
      },
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgv(argv);
  const { exitCode, result } = await runEpicAuditPrepare(values);

  if (result.kind === 'help') {
    process.stdout.write(result.text);
    return;
  }
  if (result.kind === 'validation-error') {
    process.stderr.write(`${result.message}\n${result.help}`);
    process.exit(exitCode);
  }
  process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
  if (exitCode !== 0) process.exit(exitCode);
}

runAsCli(import.meta.url, main, { source: 'epic-audit-prepare' });
