/**
 * phases/authoring-context.js — emit-context phase.
 *
 * Builds the authoring context the host LLM (or the
 * `/plan` author step) needs to write the Tech Spec.
 * Returns a plain JSON-serialisable object; never hits the network beyond
 * the provider call needed to load the Epic.
 */

import * as os from 'node:os';
import path from 'node:path';
import {
  resolveFeatureRoots,
  verifyBddRunnerPendingTag,
} from '../../bdd-runner-detect.js';
import { scanBddScenarios } from '../../bdd-scenario-scanner.js';
import { buildCodebaseSnapshot } from '../../codebase-snapshot.js';
import { getPaths, PROJECT_ROOT } from '../../config-resolver.js';
import { scanMemoryFreshness } from '../../feedback-loop/memory-freshness.js';
import { fetchPriorFeedback } from '../../feedback-loop/prior-feedback-fetcher.js';
import { Logger } from '../../Logger.js';
import { hasTicketSection } from '../../ticket-body-sections.js';
import { ensureDocsDigest } from '../docs-digest.js';
import { collectReferences, hasNewFileCue } from '../spec-freshness.js';
import { buildAuthoringGrounding } from './spec-authoring-grounding.js';

/**
 * Resolve the per-project memory directory used by the memory-freshness
 * pre-flight (Story #2557 / Epic #2547).
 *
 * Resolution order:
 *   1. `MANDREL_MEMORY_DIR` environment variable (test seam and operator
 *      override).
 *   2. `~/.claude/projects/<repo>/memory/` — the standard Claude Code
 *      memory substrate path, scoped by the configured GitHub repo so each
 *      consumer project gets its own memory pool.
 *   3. `null` when neither is resolvable. The scanner tolerates a missing
 *      `memoryDir` and surfaces a single `errors[]` entry.
 *
 * @param {{ github?: { owner?: string, repo?: string }|null }} opts
 * @returns {string|null}
 */
function resolveMemoryDir({ github } = {}) {
  if (
    typeof process.env.MANDREL_MEMORY_DIR === 'string' &&
    process.env.MANDREL_MEMORY_DIR.length > 0
  ) {
    return process.env.MANDREL_MEMORY_DIR;
  }
  const repo = github?.repo;
  if (typeof repo !== 'string' || repo.length === 0) return null;
  return path.join(os.homedir(), '.claude', 'projects', repo, 'memory');
}

/**
 * Build the digest-first `docsContext` envelope field (Story #4433 — hard
 * cutover of the § 3.1 planning read contract to digest-first with
 * pull-on-demand, mirroring the Story #4324 delivery-children cutover).
 *
 * Ensures a docs digest exists at the **same** per-Epic temp path the
 * `/deliver` story sub-agents already consume
 * (`<tempRoot>/epic-<seedIssueId>/docs-digest.md`) via the shared
 * `ensureDocsDigest` export in `docs-digest.js` — one generator, one file,
 * reused across the planning and delivery surfaces for the same Epic. The
 * envelope carries only the digest path, not embedded doc content; the
 * planner (host LLM driving the `/plan` author step) reads the digest
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
 * Build the authoring context the host LLM (or the
 * `/plan` author step) needs to write the Tech Spec.
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

  const docsContext = await buildPlanningDocsContext({
    seedIssueId: epic.id,
    settings,
    cwd,
  });

  // Story #2094 Task #2103 — verify the project's BDD runner pending-tag
  // support so the acceptance-spec body can record either the verified tag
  // (features-first ordering) or "fallback: dependencies-first ordering"
  // when no supported runner is present.
  const bddRunner = await verifyBddRunnerPendingTag({ cwd: PROJECT_ROOT });

  // Story #2637 — index existing BDD scenarios so the Acceptance Engineer
  // step can annotate planned ACs with matches from the project's
  // `.feature` files. Empty array when the project has not adopted BDD;
  // the scanner is best-effort and never throws on filesystem errors.
  let bddScenarios = [];
  try {
    const featureRoots = resolveFeatureRoots({ cwd: PROJECT_ROOT });
    bddScenarios = scanBddScenarios({ featureRoots });
  } catch (err) {
    Logger.warn(`[plan-context] BDD scenario scan skipped: ${err.message}`);
  }

  // Story #2557 — memory-freshness pre-flight runs BEFORE the prior-feedback
  // fetch so the planner sees a deduplicated, currently-actionable memory
  // store. The scanner is best-effort: missing memory dir or gh-CLI failures
  // land in `memoryFreshness.errors[]` and never throw.
  const githubCfg = opts.github ?? null;
  const memoryDir = resolveMemoryDir({ github: githubCfg });
  const memoryFreshness = await scanMemoryFreshness({
    memoryDir,
    owner: githubCfg?.owner,
    repo: githubCfg?.repo,
    projectRoot: PROJECT_ROOT,
  });

  // Story #2554 — surface open meta feedback issues to the planner so retro
  // signals are routed into durable substrates rather than lost in chat.
  // The fetcher is best-effort: missing owner/repo or gh-CLI failures land
  // in `errors[]` and never throw.
  const priorFeedback = await fetchPriorFeedback({
    owner: githubCfg?.owner,
    repo: githubCfg?.repo,
  });

  // Story #2634 — codebase snapshot. Generates a bounded structural view
  // of the consumer repo (file tree + package surface + recent activity
  // + optional export signatures at the `medium` tier) so the Architect
  // can prefer real module names over doc-only ones. The check is
  // best-effort: any git/filesystem error degrades to an empty snapshot
  // so Phase 7 stays non-blocking.
  let codebaseSnapshot = null;
  try {
    codebaseSnapshot = buildCodebaseSnapshot({
      cwd: PROJECT_ROOT,
      tier: settings?.planning?.codebaseSnapshot?.tier,
      include: settings?.planning?.codebaseSnapshot?.include,
      exclude: settings?.planning?.codebaseSnapshot?.exclude,
      recentCommitWindow:
        settings?.planning?.codebaseSnapshot?.recentCommitWindow,
    });
    // Story #4139 (F10) — ground the spec author in the files it will cite.
    // Two signals are attached to the snapshot envelope so the author (which
    // consumes the JSON, not stderr) cannot miss them:
    //   1. `grounding.truncation` — the structured, in-envelope form of the
    //      Story #3959 dropped-file warning. The skinny-tier cap used to drop
    //      the majority of matched files with only a stderr `Logger.warn` and
    //      a bare `truncated: true` flag; the author never learned the
    //      snapshot was partial (a real run dropped "377 of 627 files").
    //   2. `grounding.citedButAbsent` — path-shaped references in the Epic
    //      body (the prose the author grounds *from*) that are absent from
    //      the snapshot's file set and not phrased as net-new, so cited-but-
    //      absent surfaces are visible *during* authoring rather than only
    //      after the post-author freshness gate (Story #2635).
    // The grounding consults only the snapshot's file set and the Epic body —
    // no new filesystem or git probes — so the context stays bounded for cost.
    if (codebaseSnapshot) {
      const grounding = buildAuthoringGrounding({
        snapshot: codebaseSnapshot,
        prose: epic.body ?? '',
        collectReferences,
        hasNewFileCue,
      });
      codebaseSnapshot.grounding = grounding;
      if (grounding.truncation) {
        const { dropped, matched, tier } = grounding.truncation;
        Logger.warn(
          `[plan-context] codebase snapshot truncated: ${dropped} of ` +
            `${matched} matched file(s) dropped from the ${tier}-tier view. ` +
            `The /plan authoring context is partial. To restore full ` +
            `grounding, ` +
            `set planning.codebaseSnapshot.tier: "medium" and/or narrow ` +
            `planning.codebaseSnapshot.include in .agentrc.json.`,
        );
      }
      if (grounding.citedButAbsent.length > 0) {
        Logger.warn(
          `[plan-context] ${grounding.citedButAbsent.length} path(s) cited ` +
            `in the authored Spec are absent from the codebase snapshot: ` +
            `${grounding.citedButAbsent.join(', ')}. /plan will flag these ` +
            `as drift unless they are net-new.`,
        );
      }
    }
  } catch (err) {
    Logger.warn(`[plan-context] codebase snapshot skipped: ${err.message}`);
  }

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
    codebaseSnapshot,
    bddRunner,
    bddScenarios,
    memoryFreshness,
    priorFeedback,
  };
}
