/**
 * run-epilogue.js — real per-run closeout for `/deliver --run`.
 *
 * After the last Story in a multi-Story plan-run lands, this module:
 *   1. Selects the cross-Story audit lens roster over the combined landed
 *      tip vs base (deterministic `selectAudits` — host walks lenses).
 *   2. Rolls up friction follow-ups across every Story in the run and
 *      files/posts them on the primary Story.
 *   3. Checks sibling Spec/acceptance coherence across Story bodies.
 *
 * There is no inert planner-only path: `planRunEpilogue` enumerates steps
 * and `runPlanRunEpilogue` executes them. Single-Story runs skip the
 * epilogue (`applicable: false`).
 *
 * @module lib/orchestration/run-epilogue
 */

import { selectAudits } from '../audit-suite/index.js';
import { graduateRetroProposals } from '../feedback-loop/retro-proposals-graduator.js';
import { gitSpawn } from '../git-utils.js';
import { Logger } from '../Logger.js';
import { forEachLine } from '../observability/signals-writer.js';
import { composeRoutedProposals } from './retro-proposals.js';
import {
  buildFollowUpsCommentBody,
  resolveFollowUpRepos,
} from './story-follow-ups.js';
import { upsertStructuredComment } from './ticketing.js';

/**
 * Canonical epilogue step kinds, in execution order.
 * @type {readonly ['audit-roster', 'follow-up-rollup', 'sibling-coherence']}
 */
export const RUN_EPILOGUE_STEP_KINDS = Object.freeze([
  'audit-roster',
  'follow-up-rollup',
  'sibling-coherence',
]);

/**
 * @param {string|number|{ id?: string|number, slug?: string }} entry
 * @returns {string|null}
 */
function normalizeStoryId(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (typeof entry === 'number' && Number.isInteger(entry)) {
    return String(entry);
  }
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.id === 'string' || Number.isInteger(entry.id)) {
    return String(entry.id).trim() || null;
  }
  return typeof entry.slug === 'string' ? entry.slug.trim() || null : null;
}

/**
 * @param {Array<string|number|{ id?: string|number, slug?: string }>} stories
 * @returns {string[]}
 */
function normalizeStoryIds(stories) {
  const list = Array.isArray(stories) ? stories : [];
  const seen = new Set();
  const ids = [];
  for (const entry of list) {
    const id = normalizeStoryId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Enumerate the ordered epilogue steps for a completed run.
 *
 * @param {object} args
 * @param {string} args.planRunId
 * @param {Array<string|number|{ id?: string|number, slug?: string }>} args.stories
 * @returns {object}
 */
export function planRunEpilogue({ planRunId, stories } = {}) {
  const ids = normalizeStoryIds(stories);
  const runId =
    typeof planRunId === 'string' && planRunId.trim() !== ''
      ? planRunId.trim()
      : null;

  if (ids.length <= 1) {
    return {
      applicable: false,
      planRunId: runId,
      stories: ids,
      steps: [],
      reason:
        ids.length === 0
          ? 'no Stories in run'
          : 'single-Story run — per-Story close is the end; no run-scoped epilogue',
    };
  }

  if (runId === null) {
    return {
      applicable: false,
      planRunId: null,
      stories: ids,
      steps: [],
      reason: 'multi-Story run requires a planRunId to anchor the epilogue',
    };
  }

  const steps = [
    {
      kind: 'audit-roster',
      description: `Select cross-Story audit lenses for run ${runId}`,
      stories: ids,
    },
    {
      kind: 'follow-up-rollup',
      description: `Friction follow-up roll-up for run ${runId}`,
      stories: ids,
    },
    {
      kind: 'sibling-coherence',
      description: `Sibling-coherence check across the ${ids.length} Story specs of run ${runId}`,
      stories: ids,
    },
  ];

  return { applicable: true, planRunId: runId, stories: ids, steps };
}

async function listChangedFiles(cwd, baseRef = 'origin/main') {
  try {
    const result = gitSpawn(cwd, 'diff', '--name-only', `${baseRef}...HEAD`);
    if (result.status !== 0) return [];
    return String(result.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function executeAuditRoster({ planRunId, stories, cwd, provider }) {
  const primaryId = Number(stories[0]);
  const changedFiles = await listChangedFiles(cwd);
  let selectedAudits = [];
  if (Number.isInteger(primaryId) && primaryId > 0) {
    const selected = await selectAudits({
      ticketId: primaryId,
      gate: 'gate3',
      provider,
      baseBranch: 'main',
      headRef: 'HEAD',
    });
    selectedAudits = Array.isArray(selected?.selectedAudits)
      ? selected.selectedAudits
      : Array.isArray(selected)
        ? selected
        : [];
  }
  const body = [
    '### plan-run-audit-roster',
    '',
    `Cross-Story audit roster for plan-run \`${planRunId}\`.`,
    '',
    `Changed files considered: ${changedFiles.length}.`,
    '',
    '**Selected lenses** (host MUST walk each against the combined landed diff):',
    ...(selectedAudits.length > 0
      ? selectedAudits.map((lens) => `- \`${lens}\``)
      : ['- _(none — docs-only or no matching change-set lenses)_']),
    '',
    '```json',
    JSON.stringify(
      {
        planRunId,
        stories: stories.map(Number),
        changedFiles,
        selectedAudits,
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
  if (Number.isInteger(primaryId) && primaryId > 0) {
    await upsertStructuredComment(
      provider,
      primaryId,
      'plan-run-audit-roster',
      body,
    );
  }
  return {
    kind: 'audit-roster',
    selectedAudits,
    changedFileCount: changedFiles.length,
  };
}

async function executeFollowUpRollup({
  planRunId,
  stories,
  provider,
  config,
  cwd,
}) {
  const signals = [];
  for (const raw of stories) {
    const sid = Number(raw);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    await forEachLine(
      null,
      sid,
      (parsed) => {
        if (!parsed || typeof parsed !== 'object') return;
        const category =
          typeof parsed.category === 'string' ? parsed.category.trim() : '';
        if (!category) return;
        const source = parsed.source === 'framework' ? 'framework' : 'consumer';
        signals.push({ category, source });
      },
      config,
    );
  }
  const repos = resolveFollowUpRepos(config);
  const primaryId = Number(stories[0]);
  const proposals = composeRoutedProposals({
    anchorId: Number.isInteger(primaryId) ? primaryId : 1,
    anchorKind: 'run',
    frameworkRepo: repos.frameworkRepo,
    consumerRepo: repos.consumerRepo,
    signals,
    unresolvedBlockedEvents: [],
  });
  // Patch titles to mention the plan-run token (anchorKind run uses numeric id).
  for (const item of [...proposals.framework, ...proposals.consumer]) {
    item.title = item.title.replace(/plan-run \d+/, `plan-run ${planRunId}`);
    item.body = item.body.replace(/plan-run \d+/g, `plan-run ${planRunId}`);
  }
  const graduated = await graduateRetroProposals({
    epicId: primaryId,
    provider,
    config,
    currentRepo: repos.currentRepo,
    frameworkRepo: (() => {
      const [owner, repo] = repos.frameworkRepo.split('/');
      return { owner, repo };
    })(),
    routedProposals: proposals,
    cwd,
  });
  if (Number.isInteger(primaryId) && primaryId > 0) {
    const body = buildFollowUpsCommentBody({
      storyId: primaryId,
      proposals,
      graduated,
    }).replace(
      `from Story #${primaryId}`,
      `from plan-run \`${planRunId}\` (primary Story #${primaryId})`,
    );
    await upsertStructuredComment(provider, primaryId, 'follow-ups', body);
  }
  return {
    kind: 'follow-up-rollup',
    signalCount: signals.length,
    filed: graduated.filed?.length ?? 0,
  };
}

function extractSection(body, heading) {
  if (typeof body !== 'string') return '';
  const re = new RegExp(
    `(?:^|\\n)## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
    'i',
  );
  const match = body.match(re);
  return match ? match[1].trim() : '';
}

async function executeSiblingCoherence({ planRunId, stories, provider }) {
  const findings = [];
  const bodies = [];
  for (const raw of stories) {
    const sid = Number(raw);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    const ticket = await provider.getTicket(sid);
    bodies.push({
      id: sid,
      title: ticket?.title ?? '',
      acceptance: extractSection(ticket?.body ?? '', 'Acceptance'),
      spec: extractSection(ticket?.body ?? '', 'Spec'),
    });
  }
  const withAcceptance = bodies.filter((b) => b.acceptance.length > 0);
  if (withAcceptance.length > 0 && withAcceptance.length < bodies.length) {
    const missing = bodies
      .filter((b) => b.acceptance.length === 0)
      .map((b) => `#${b.id}`);
    findings.push(
      `Stories missing ## Acceptance while siblings declare ACs: ${missing.join(', ')}`,
    );
  }
  // Detect identical non-empty Spec blobs (likely copy-paste drift).
  const specMap = new Map();
  for (const b of bodies) {
    if (!b.spec) continue;
    const key = b.spec.replace(/\s+/g, ' ').slice(0, 400);
    if (!specMap.has(key)) specMap.set(key, []);
    specMap.get(key).push(b.id);
  }
  for (const ids of specMap.values()) {
    if (ids.length > 1) {
      findings.push(
        `Duplicate ## Spec prose across Stories ${ids.map((id) => `#${id}`).join(', ')} — split or dedupe.`,
      );
    }
  }
  const primaryId = Number(stories[0]);
  const body = [
    '### plan-run-sibling-coherence',
    '',
    `Sibling-coherence check for plan-run \`${planRunId}\`.`,
    '',
    findings.length === 0
      ? '_No coherence findings._'
      : findings.map((f) => `- ${f}`).join('\n'),
    '',
    '```json',
    JSON.stringify(
      { planRunId, stories: stories.map(Number), findings },
      null,
      2,
    ),
    '```',
  ].join('\n');
  if (Number.isInteger(primaryId) && primaryId > 0) {
    await upsertStructuredComment(
      provider,
      primaryId,
      'plan-run-sibling-coherence',
      body,
    );
  }
  return { kind: 'sibling-coherence', findings };
}

/**
 * Execute the per-run epilogue. Throws only on programmer misuse; step
 * failures are collected into `errors[]`.
 *
 * @param {object} args
 * @param {string} args.planRunId
 * @param {Array<string|number>} args.stories
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {string} [args.cwd]
 * @returns {Promise<object>}
 */
export async function runPlanRunEpilogue({
  planRunId,
  stories,
  provider,
  config,
  cwd = process.cwd(),
} = {}) {
  const plan = planRunEpilogue({ planRunId, stories });
  if (!plan.applicable) {
    return { ...plan, results: [], errors: [] };
  }
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new TypeError('runPlanRunEpilogue requires a ticketing provider');
  }

  const results = [];
  const errors = [];
  for (const step of plan.steps) {
    try {
      if (step.kind === 'audit-roster') {
        results.push(
          await executeAuditRoster({
            planRunId: plan.planRunId,
            stories: plan.stories,
            cwd,
            provider,
          }),
        );
      } else if (step.kind === 'follow-up-rollup') {
        results.push(
          await executeFollowUpRollup({
            planRunId: plan.planRunId,
            stories: plan.stories,
            provider,
            config,
            cwd,
          }),
        );
      } else if (step.kind === 'sibling-coherence') {
        results.push(
          await executeSiblingCoherence({
            planRunId: plan.planRunId,
            stories: plan.stories,
            provider,
          }),
        );
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      Logger.warn(`[run-epilogue] step ${step.kind} failed: ${message}`);
      errors.push({ kind: step.kind, message });
    }
  }

  return {
    applicable: true,
    planRunId: plan.planRunId,
    stories: plan.stories,
    steps: plan.steps,
    results,
    errors,
  };
}
