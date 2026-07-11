#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-audit-prepare.js — Phase 4 prepare CLI for `/deliver`.
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
 *      them into the change-set selection,
 *   5. resolving the run's audit depth (`light` / `standard` / `deep`) from
 *      the same risk envelope + the change-set's changed-file count via the
 *      shared `resolveDepth` resolver (Story #3939), and
 *   6. shaping the result into the helper-consumable envelope.
 *
 * Story #3939 — depth-aware lenses. The `depth` field tells the audit
 * executor (`helpers/epic-audit.md`) how thorough each selected lens should
 * be on this Epic without ever skipping a selected lens:
 * `light` shrinks a lens's sweep to the changed surface + Critical/High
 * findings, `standard` is today's behavior, and `deep` widens the sweep to
 * the directly-touched modules. Depth never changes which lenses fire, the
 * severity taxonomy, the findings shape, or the Phase 4 halting rule — it is
 * an orthogonal "how deep" signal alongside the "which lenses" selection.
 * Depth is resolved from the SAME best-effort `planningRisk` checkpoint read
 * the risk-routed lenses use (a missing/unparseable checkpoint degrades to
 * `standard`, never an abort) folded with the changed-file count the
 * change-set diff already produces.
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
 *     "depth": "deep",
 *     "selectedAudits": ["audit-security", "audit-privacy"],
 *     "epicCloseLenses": ["audit-security"],
 *     "changeSetAudits": ["audit-privacy"],
 *     "riskRoutedAudits": ["audit-security"],
 *     "globalLenses": [],
 *     "changedFiles": ["src/api/admin/users.ts", "..."],
 *     "changedFilesCount": 47,
 *     "substitutionsPayload": "src/api/admin/users.ts\n..."
 *   }
 *
 * `selectedAudits` is the union the helper dispatches: the change-set
 * selection (`changeSetAudits`) plus the risk-routed lenses
 * (`riskRoutedAudits`), de-duplicated. The two source-of-truth arrays are
 * surfaced for observability so the operator can see why each lens fired.
 * `depth` (`light` / `standard` / `deep`) is the orthogonal "how deep each
 * selected lens runs" signal (Story #3939).
 *
 * Epic #4131 (F2/F3) — `globalLenses` is the subset of `selectedAudits` on the
 * global-lens allowlist (`GLOBAL_LENS_ALLOWLIST`, e.g. `audit-navigability`):
 * lenses the helper runs against the WHOLE route tree, exempt from the
 * cross-epic-leak guard's change-set narrowing (`#3362`). The exemption is
 * scoped to these lenses only — every other selected lens stays scoped to
 * `changedFiles`, and the guard is not weakened for them. The navigability lens
 * is also auto-selected here when a changed file matches a consumer-configured
 * route glob (`delivery.quality.navigability.routeGlobs`), routed through the
 * SAME risk-routed-lens union; with no route globs configured it routes
 * nothing (silent no-op).
 *
 * Usage:
 *   node .agents/scripts/epic-audit-prepare.js --epic <epicId> [--base-branch main]
 *
 * Exit codes:
 *   0 — envelope written to stdout
 *   2 — validation error (missing/invalid --epic)
 *   1 — provider / git failure
 */

import {
  GLOBAL_LENS_ALLOWLIST,
  isGlobalLens,
  routesNavigabilityLens,
  selectAudits,
} from './lib/audit-suite/index.js';
import { defineFlags } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  resolveAuditLenses,
  selectEpicCloseLenses,
} from './lib/orchestration/code-review.js';
import { read as readPlanState } from './lib/orchestration/epic-plan-state-store.js';
import { resolveDepth } from './lib/orchestration/review-depth.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-audit-prepare.js --epic <epicId> [--base-branch main]

Flags:
  --epic         Epic ticket ID to prepare audit selection for (required).
  --base-branch  Branch to diff against for the selector's change-set
                 input (default: main).
  --gate         Audit gate label (default: gate3 — Epic close gate).
  --help         Show this message.

Output (JSON envelope on stdout):
  epicId, epicBranch
  depth              Audit depth for this run — one of light | standard | deep
                     (Story #3939). Resolved from the model-judged risk
                     envelope + the change-set's changed-file count via the
                     shared resolveDepth resolver; an absent checkpoint
                     degrades to standard. Tells the audit executor how deep
                     each SELECTED lens runs; it never changes which lenses
                     fire, the severity taxonomy, or the Phase 4 halting rule.
  selectedAudits     De-duplicated union of changeSetAudits + riskRoutedAudits.
  epicCloseLenses    The SLIM Epic-close roster (Story #4412): selectedAudits
                     with every local-tier change-set lens excluded, keeping
                     only cumulative + global change-set lenses plus every
                     risk-routed lens. This is the roster the Phase 5
                     code-review pass walks over the cumulative Epic diff —
                     local-tier concerns are already verified shift-left
                     (write-time checklists + the Story-scope local-lens pass),
                     so they are not re-run at Epic close.
  changeSetAudits    Lenses the change-set selector chose.
  riskRoutedAudits   Lenses routed from the model-judged high-risk axes plus the
                     navigability lens when a changed file matches a configured
                     route glob (Epic #4131, F3).
  globalLenses       Subset of selectedAudits on the global-lens allowlist
                     (e.g. audit-navigability) — run against the WHOLE route
                     tree, exempt from the cross-epic-leak guard (Epic #4131,
                     F2). Empty unless a global lens was selected.
  changedFiles, changedFilesCount, substitutionsPayload
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
 * Resolve the operator's `planning.taskSizing` override the same way the
 * ticket validator and the code-review depth resolver do, so retuning sizing
 * retunes the audit-depth thresholds in lockstep. Reads `config.planning`
 * first, then the legacy `config.agentSettings.planning` nest; absent →
 * `undefined` so {@link resolveDepth} falls back to `DEFAULT_TASK_SIZING`.
 *
 * @param {object|null|undefined} config
 * @returns {object|undefined}
 */
function resolveTaskSizing(config) {
  return (
    config?.planning?.taskSizing ??
    config?.agentSettings?.planning?.taskSizing ??
    undefined
  );
}

/**
 * Resolve the run's audit depth (`light` / `standard` / `deep`) for an Epic
 * via the shared {@link resolveDepth} resolver (Story #3939), folding the
 * model-judged risk envelope's `overallLevel` (read off the Epic's
 * `epic-plan-state` checkpoint) with the mechanical changed-file count of the
 * change set the prepare CLI already enumerated.
 *
 * Best-effort and total, mirroring `resolveRiskRoutedLenses`: a
 * missing/unparseable checkpoint, an absent `planningRisk` field, or a
 * provider read failure all degrade to `standard` — the neutral default that
 * preserves today's behavior — so an Epic that skipped `/plan` (no
 * checkpoint) still gets a passing `standard` pass with no new failure mode.
 * The changed-file count can only escalate a low-risk Epic to `deep` (a wide
 * diff) and never downgrades a high-risk one; an unknown/absent count is the
 * neutral "width unknown" signal {@link resolveDepth} tolerates.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   changedFileCount: number|null,
 *   sizing?: object|undefined,
 *   readPlanState?: typeof readPlanState,
 * }} params
 * @returns {Promise<import('./lib/orchestration/review-depth.js').ReviewDepth>}
 */
export async function resolveRunDepth({
  epicId,
  provider,
  changedFileCount,
  sizing,
  readPlanState: readPlanStateFn = readPlanState,
}) {
  let state = null;
  try {
    state = await readPlanStateFn({ provider, epicId });
  } catch {
    // A read failure must not abort the audit. Resolve from the diff width
    // alone (width can still escalate to `deep`); an unknown width with no
    // risk signal lands on `standard`.
    return resolveDepth({ changedFileCount, sizing });
  }
  return resolveDepth({
    overallLevel: state?.planningRisk?.overallLevel,
    changedFileCount,
    sizing,
  });
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
 *   resolveRunDepth?: typeof resolveRunDepth,
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
  // shared checkout's HEAD (Story #3362). Under two concurrent /deliver
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
  const riskRoutedFromVerdict = await resolveRiskRoutedLenses({
    epicId,
    provider,
    readPlanState: deps.readPlanState,
    resolveAuditLenses: deps.resolveAuditLenses,
  });

  // Epic #4131 (F3) — route the navigability lens onto route-adding change
  // sets through the SAME risk-routed-lens union: when a changed file matches a
  // consumer-configured route glob (`delivery.quality.navigability.routeGlobs`)
  // the lens joins `riskRoutedAudits`, exactly like a verdict-routed lens. No
  // new routing function is introduced — the predicate feeds the existing
  // `unionAudits` seam. Unconfigured consumers route nothing (silent no-op), so
  // the change-set-scoped selection is unchanged. `cfg` may be `{}` in tests;
  // the predicate tolerates an absent config and returns `false`.
  const navigabilityRouted = routesNavigabilityLens({
    changedFiles,
    config: cfg,
  })
    ? GLOBAL_LENS_ALLOWLIST.slice()
    : [];
  const riskRoutedAudits = unionAudits(
    riskRoutedFromVerdict,
    navigabilityRouted,
  );
  const selectedAudits = unionAudits(changeSetAudits, riskRoutedAudits);

  // Story #4412 (Epic #4405) — the SLIM Epic-close roster. Restrict the gate3
  // selection to the tiers the Epic-close pass owns: cumulative + global
  // change-set lenses plus every risk-routed lens, dropping every local-tier
  // change-set lens (routed off `resolveLensTier` in `selectEpicCloseLenses`).
  // Local-tier concerns are already verified shift-left — the write-time
  // checklist threading (#4410) and the maker-blind Story-scope local-lens
  // pass (#4409) — so re-running them over the cumulative diff at close would
  // verify the same concern at a second tier. This is the roster the Phase 5
  // code-review pass walks; `selectedAudits` stays the pre-slim union for
  // observability.
  const epicCloseLenses = selectEpicCloseLenses({
    changeSetAudits,
    riskRoutedAudits,
  });

  // Epic #4131 (F2) — surface which selected lenses are on the global-lens
  // allowlist so the helper runs them against the WHOLE route tree, exempt from
  // the cross-epic-leak guard's change-set narrowing (`#3362`). The exemption
  // is scoped to these lenses only; every other selected lens stays scoped to
  // `changedFiles`. Order follows `selectedAudits` for a deterministic list.
  const globalLenses = selectedAudits.filter(isGlobalLens);

  // Story #3939 — resolve the run's audit depth from the SAME model-judged
  // risk envelope the lenses route from, folded with the changed-file count
  // the change set just produced. Best-effort: an absent checkpoint degrades
  // to `standard`. Depth tells the executor how deep each SELECTED lens runs;
  // it never changes the lens roster above.
  const resolveRunDepthFn = deps.resolveRunDepth ?? resolveRunDepth;
  const depth = await resolveRunDepthFn({
    epicId,
    provider,
    changedFileCount: changedFiles.length,
    sizing: resolveTaskSizing(cfg),
    readPlanState: deps.readPlanState,
  });

  return {
    exitCode: 0,
    result: {
      kind: 'envelope',
      envelope: {
        epicId,
        epicBranch,
        depth,
        selectedAudits,
        epicCloseLenses,
        changeSetAudits,
        riskRoutedAudits,
        globalLenses,
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
