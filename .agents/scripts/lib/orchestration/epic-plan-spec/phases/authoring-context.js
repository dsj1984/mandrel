/**
 * phases/authoring-context.js — emit-context phase.
 *
 * Builds the authoring context the host LLM (or the
 * `epic-plan-spec-author` Skill) needs to write the Tech Spec.
 * Returns a plain JSON-serialisable object; never hits the network beyond
 * the provider call needed to load the Epic.
 */

import * as os from 'node:os';
import path from 'node:path';
import {
  resolveFeatureRoots,
  verifyBddRunnerPendingTag,
} from '../../../bdd-runner-detect.js';
import { scanBddScenarios } from '../../../bdd-scenario-scanner.js';
import { buildCodebaseSnapshot } from '../../../codebase-snapshot.js';
import { getLimits, PROJECT_ROOT } from '../../../config-resolver.js';
import { hasEpicSection } from '../../../epic-body-sections.js';
import { scanMemoryFreshness } from '../../../feedback-loop/memory-freshness.js';
import { fetchPriorFeedback } from '../../../feedback-loop/prior-feedback-fetcher.js';
import { Logger } from '../../../Logger.js';
import { buildDocsContext } from '../../doc-reader.js';
import { applyBudget } from '../../planning-context-budget.js';
import { collectReferences, hasNewFileCue } from '../../spec-freshness.js';
import {
  ACCEPTANCE_SPEC_SYSTEM_PROMPT,
  TECH_SPEC_SYSTEM_PROMPT,
} from './prompts.js';
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
export function resolveMemoryDir({ github } = {}) {
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
 * Build the authoring context the host LLM (or the
 * `epic-plan-spec-author` Skill) needs to write the Tech Spec.
 *
 * `docsContext` is bounded by the planning-context budget (Epic #817 Story 9):
 * over-budget payloads downgrade to a summary representation with headings +
 * bounded excerpts. Pass `{ fullContext: true }` (CLI: `--full-context`) to
 * restore the unbounded full-body envelope. The Epic body itself is always
 * subject to the same budget so a sprawling Epic narrative cannot bypass the
 * cap by riding on top of `docsContext`.
 */
export async function buildAuthoringContext(
  epicId,
  provider,
  settings = {},
  opts = {},
) {
  const epic = await provider.getEpic(epicId);
  if (!epic) {
    throw new Error(`Epic #${epicId} not found.`);
  }

  const planningLimits = getLimits(settings).planningContext;
  const { fullContext = false } = opts;

  const docsContext = await buildDocsContext(settings, planningLimits, {
    fullContext,
  });

  const epicBody = applyBudget(
    [{ path: `epic-${epic.id}.md`, content: epic.body ?? '' }],
    planningLimits,
    { fullContext },
  );

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
    Logger.warn(`[epic-plan-spec] BDD scenario scan skipped: ${err.message}`);
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
          `[epic-plan-spec] codebase snapshot truncated: ${dropped} of ` +
            `${matched} matched file(s) dropped from the ${tier}-tier view. ` +
            `The spec-author context is partial. To restore full grounding, ` +
            `set planning.codebaseSnapshot.tier: "medium" and/or narrow ` +
            `planning.codebaseSnapshot.include in .agentrc.json.`,
        );
      }
      if (grounding.citedButAbsent.length > 0) {
        Logger.warn(
          `[epic-plan-spec] ${grounding.citedButAbsent.length} path(s) cited ` +
            `in the Epic body are absent from the codebase snapshot: ` +
            `${grounding.citedButAbsent.join(', ')}. The spec author will ` +
            `flag these as drift unless they are net-new.`,
        );
      }
    }
  } catch (err) {
    Logger.warn(`[epic-plan-spec] codebase snapshot skipped: ${err.message}`);
  }

  // Epic #3865 — planning risk is no longer classified at emit-context
  // time. The `epic-plan-spec-author` Skill authors the risk verdict
  // (`risk-verdict.json`) as the fourth planning artifact, and the persist
  // half derives the planningRisk envelope from it via deriveRiskEnvelope.

  return {
    epic: {
      id: epic.id,
      title: epic.title,
      body: epicBody.mode === 'full' ? epic.body : null,
      bodySummary: epicBody.mode === 'summary' ? epicBody.items[0] : null,
      // Story #4324: the context-ticket classes are retired. A re-planned
      // Epic's previous Tech Spec / Acceptance Table content rides along
      // inside `body` (managed sections), which is how the author keeps
      // AC IDs stable across re-plans.
      planningSections: {
        techSpec: hasEpicSection(epic.body ?? '', 'techSpec'),
        acceptanceTable: hasEpicSection(epic.body ?? '', 'acceptanceTable'),
      },
    },
    docsContext,
    codebaseSnapshot,
    systemPrompts: {
      techSpec: TECH_SPEC_SYSTEM_PROMPT,
      acceptanceSpec: ACCEPTANCE_SPEC_SYSTEM_PROMPT,
    },
    bddRunner,
    bddScenarios,
    memoryFreshness,
    priorFeedback,
  };
}
