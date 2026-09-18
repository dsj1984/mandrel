/**
 * phases/authoring-context.js — emit-context phase.
 *
 * Builds the authoring context the host LLM (or the
 * `/mandrel-plan` author step) needs to write the Tech Spec.
 * Returns a plain JSON-serialisable object; never hits the network beyond
 * the provider call needed to load the Epic.
 */

import path from 'node:path';
import {
  resolveFeatureRoots,
  verifyBddRunnerPendingTag,
} from '../../bdd-runner-detect.js';
import { capBddScenarios } from '../../bdd-scenario-budget.js';
import { scanBddScenarios } from '../../bdd-scenario-scanner.js';
import { getPaths, PROJECT_ROOT } from '../../config-resolver.js';
import { fetchPriorFeedback } from '../../feedback-loop/prior-feedback-fetcher.js';
import { Logger } from '../../Logger.js';
import { hasTicketSection } from '../../ticket-body-sections.js';
import {
  concurrentMap,
  FANOUT_CONCURRENCY,
} from '../../util/concurrent-map.js';
import { ensureDocsDigest } from '../docs-digest.js';
import { buildMemoryPoolAdvisory } from './memory-pool-advisory.js';

/**
 * Build the digest-first `docsContext` envelope field (Story #4433 — hard
 * cutover of the § 3.1 planning read contract to digest-first with
 * pull-on-demand, mirroring the Story #4324 delivery-children cutover).
 *
 * Ensures a docs digest exists at the **same** per-Epic temp path the
 * `/mandrel-deliver` story sub-agents already consume
 * (`<tempRoot>/epic-<seedIssueId>/docs-digest.md`) via the shared
 * `ensureDocsDigest` export in `docs-digest.js` — one generator, one file,
 * reused across the planning and delivery surfaces for the same Epic. The
 * envelope carries only the digest path, not embedded doc content; the
 * planner (host LLM driving the `/mandrel-plan` author step) reads the digest
 * and pulls a full file/section on demand when it bears on the decision.
 *
 * Returns `null` — a silent no-op — when `project.docsContextFiles` is not
 * configured. There is no scrape-every-markdown-under-docsRoot fallback for
 * planning; that fallback remains a `doc-reader.js` primitive used
 * elsewhere, not part of this envelope.
 *
 * @param {{ seedIssueId: number, settings: object, cwd: string }} args
 * @returns {Promise<{ mode: 'digest', digestPath: string } | null>}
 */
async function buildPlanningDocsContext({ seedIssueId, settings, cwd }) {
  const docsContextFiles = Array.isArray(settings?.docsContextFiles)
    ? settings.docsContextFiles
    : [];
  if (docsContextFiles.length === 0) return null;

  const paths = getPaths({ project: { paths: settings?.paths } });
  const docsRoot = path.resolve(cwd, paths.docsRoot);
  const relPath = path.join(
    paths.tempRoot,
    `epic-${seedIssueId}`,
    'docs-digest.md',
  );
  const absPath = path.resolve(cwd, relPath);

  const result = await ensureDocsDigest({
    docsContextFiles,
    docsRoot,
    outputPath: absPath,
  });
  if (!result) return null;
  return { mode: 'digest', digestPath: relPath };
}

/**
 * Story #2637 — index existing BDD scenarios so the Acceptance Engineer step
 * can annotate planned ACs with matches from the project's `.feature` files.
 * Empty (capped-shape) result when the project has not adopted BDD; the
 * scanner is best-effort and never throws on filesystem errors.
 *
 * Story #4977 — the scan itself stays uncapped (a faithful `.feature`
 * index), but the envelope-bound result is truncated to
 * `BDD_SCENARIOS_BYTE_BUDGET` via `capBddScenarios` so a mature Gherkin
 * corpus cannot alone consume the `/mandrel-plan` context-envelope ceiling. Callers
 * needing the raw count read `totalScenarios` vs `includedScenarios`.
 *
 * @returns {ReturnType<typeof capBddScenarios>}
 */
function scanBddScenariosBestEffort() {
  try {
    const featureRoots = resolveFeatureRoots({ cwd: PROJECT_ROOT });
    return capBddScenarios(scanBddScenarios({ featureRoots }));
  } catch (err) {
    Logger.warn(`[plan-context] BDD scenario scan skipped: ${err.message}`);
    return capBddScenarios([]);
  }
}

/**
 * Build the authoring context the host LLM (or the
 * `/mandrel-plan` author step) needs to write the Tech Spec.
 *
 * `docsContext` is digest-first (Story #4433): a pointer at the per-Epic
 * docs digest rather than embedded doc content, `null` when
 * `project.docsContextFiles` is unset.
 *
 * The body carried here is **unbounded**. Story #4541 removed the
 * `applyBudget` pass (and the `--full-context` flag that toggled it): both
 * `plan-context.js` envelope builders discard this `epic` field entirely and
 * ship the raw seed on `seed.content` instead, so the budget bounded nothing
 * that shipped and the flag was a no-op. The raw-seed passthrough is
 * deliberate and test-pinned; the budget pass was the orphan. Envelope size
 * is guarded where it is actually decided — `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING`
 * in `lib/orchestration/plan-context.js`.
 */
export async function buildAuthoringContext(
  seedIssueId,
  provider,
  settings = {},
  opts = {},
) {
  // Epic #4474 (M3 PR2): `opts.epic` is an optional prefetched Epic object
  // so a caller that already holds the issue (the folded `plan-context.js`
  // envelope build, which also needs the raw body for clarity scoring and
  // re-plan detection) does not pay a second provider fetch. Absent, the
  // fetch behaviour is unchanged.
  const epic = opts.epic ?? (await provider.getEpic(seedIssueId));
  if (!epic) {
    throw new Error(`Epic #${seedIssueId} not found.`);
  }

  const { cwd = PROJECT_ROOT } = opts;

  const githubCfg = opts.github ?? null;

  // Story #4952 — these five gathers share no data, so they run under bounded
  // concurrency instead of five sequential awaits on the interactive `/mandrel-plan`
  // path. `concurrentMap` preserves input order, so the destructuring is
  // positional and the produced context is identical to the serial build:
  //
  //   1. the digest-first `docsContext` pointer (Story #4433);
  //   2. Story #2094 Task #2103 — the project's BDD runner pending-tag
  //      support, so the acceptance-spec body records either the verified tag
  //      (features-first ordering) or "fallback: dependencies-first ordering"
  //      when no supported runner is present;
  //   3. the best-effort `.feature` scenario index;
  //   4. Story #4919 — the memory-pool advisory that replaced the retired
  //      memory-freshness pre-flight (#2557 / #4414) in the same slot. The
  //      scanner marked an entry stale when a cited issue was closed, but the
  //      memory corpus is delivery retrospectives whose subject IS a delivered
  //      Story — and its directory (`~/.claude/projects/<repo>/memory/`) never
  //      resolved, because harness project dirs are cwd-slugs. This renders no
  //      per-entry verdict at all: it stats and counts, and the `/mandrel-plan` spine
  //      surfaces `recommend` at Gate #1. Filesystem-only and total;
  //   5. Story #2554 — open meta feedback issues, so retro signals are routed
  //      into durable substrates rather than lost in chat. Best-effort:
  //      missing owner/repo or gh-CLI failures land in `errors[]`, never throw.
  const [
    docsContext,
    bddRunner,
    bddScenarios,
    memoryPoolAdvisory,
    priorFeedback,
  ] = await concurrentMap(
    [
      () => buildPlanningDocsContext({ seedIssueId: epic.id, settings, cwd }),
      () => verifyBddRunnerPendingTag({ cwd: PROJECT_ROOT }),
      () => scanBddScenariosBestEffort(),
      () => buildMemoryPoolAdvisory({ cwd: PROJECT_ROOT }),
      () =>
        fetchPriorFeedback({
          owner: githubCfg?.owner,
          repo: githubCfg?.repo,
        }),
    ],
    (gather) => gather(),
    // The independent context gathers (Story #4952): a handful of local
    // probes plus one `gh` read, so this rides the shared fan-out bound
    // rather than declaring its own.
    { concurrency: FANOUT_CONCURRENCY },
  );

  // Story #4811 — the codebase snapshot (#2634), its authoring grounding
  // (#4139 F10) and the spec-freshness helpers behind it are retired. The
  // pre-computed structural view grounded nothing it promised: the default
  // include globs missed the standard monorepo layout outright, its remedies
  // pointed at knobs that re-filtered the same set, and its cited-but-absent
  // signal inverted into noise whenever the snapshot was the thing that was
  // wrong. Grounding now rests on the two mechanisms that read the real tree:
  // the authoring model's own targeted retrieval (the digest-first precedent
  // of Story #4433) and the Phase 8 `validateStoryFileAssumptions` gate, which
  // probes every authored `{path, assumption}` against the working tree as a
  // hard error. Nothing pre-computed replaces it — a stale inventory is the
  // failure mode, not the fix.

  // Story #4542 — planning authors no risk artifact at all. Review depth and
  // the acceptance-critic mode are derived from the diff at close time
  // (`review-depth.js#deriveChangeLevel`), so there is nothing to classify
  // here and nothing for the author step to judge about itself.

  return {
    epic: {
      id: epic.id,
      title: epic.title,
      body: epic.body ?? null,
      // Story #4324: the context-ticket classes are retired. A re-planned
      // Epic's previous Tech Spec / Acceptance Table content rides along
      // inside `body` (managed sections), which is how the author keeps
      // AC IDs stable across re-plans.
      planningSections: {
        techSpec: hasTicketSection(epic.body ?? '', 'techSpec'),
        acceptanceTable: hasTicketSection(epic.body ?? '', 'acceptanceTable'),
      },
    },
    docsContext,
    bddRunner,
    bddScenarios,
    memoryPoolAdvisory,
    priorFeedback,
  };
}
