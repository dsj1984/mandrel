#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-prepare.js — Step 0/1 of the operator-driven `/deliver`.
 *
 * Composes the existing engine phases that the in-process epic-runner used to
 * call sequentially, but does NOT dispatch any Stories. The CLI is the single
 * point at which the slash-command captures:
 *
 *   1. The Epic ticket snapshot (`runSnapshotPhase`).
 *   2. The story DAG (`runBuildWaveDagPhase`) computed from every child Story —
 *      used here only to enumerate the open Story set and run the
 *      concurrency-hazard gate; the ready-set runtime re-derives readiness
 *      from live labels on every `tick`, so the prepare no longer persists a
 *      wave grouping.
 *   3. The seeded `epic-run-state` checkpoint (`epic-run-state-store.initialize`)
 *      in the per-Story-status shape (Story #4155): a flat
 *      `stories: { [storyId]: { status: 'pending' } }` map plus the GLOBAL
 *      in-flight `concurrencyCap`. Idempotent — re-running prepare against a
 *      partially-driven Epic preserves the original `startedAt` and every
 *      already-recorded Story status (it never resets recorded progress).
 *   4. The dispatch hint (`StoryLauncher.planWave`) — a deterministic list of
 *      `{ storyId, worktree }` entries the slash command uses to resolve
 *      per-Story worktree paths. The ready-set `tick` selects which of these
 *      to dispatch on each beat; the prepare only enumerates the set.
 *
 * Stdout is a single JSON envelope so the slash command can parse without
 * re-reading any tickets.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-prepare.js --epic <epicId>
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runBootSweep } from './boot-sweep.js';
import { buildChecklistPayload } from './lib/audit-suite/index.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  getPaths,
  getRunners,
  resolveConfig,
  resolveRuntime,
} from './lib/config-resolver.js';
import { cachedGitFetch } from './lib/git/cached-fetch.js';
import {
  ensureEpicBranchRef,
  currentBranch as gitCurrentBranch,
} from './lib/git-branch-lifecycle.js';
import { getEpicBranch, gitSpawn, gitSync } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { ACCEPTANCE_NA, TYPE_LABELS } from './lib/label-constants.js';
import { parseDeliverySlicingTable } from './lib/orchestration/consolidation-precondition.js';
import { ensureDocsDigest } from './lib/orchestration/docs-digest.js';
import {
  resolveOperator,
  runPrepareGuards,
} from './lib/orchestration/epic-deliver-lease-guard.js';
import {
  initialize as initializeEpicRunState,
  initializeSingle as initializeEpicRunStateSingle,
  write as writeEpicRunState,
} from './lib/orchestration/epic-run-state-store.js';
import {
  collectPendingStoryKeys,
  evaluateConcurrencyGate,
  filterFindingsToPending,
  renderGateErrorMessage,
} from './lib/orchestration/epic-runner/concurrency-gate.js';
import { runBuildWaveDagPhase } from './lib/orchestration/epic-runner/phases/build-wave-dag.js';
import { runSnapshotPhase } from './lib/orchestration/epic-runner/phases/snapshot.js';
import { StoryLauncher } from './lib/orchestration/epic-runner/story-launcher.js';
import { collectStoryAssumptionEntries } from './lib/orchestration/file-assumptions.js';
import {
  computeBaseSha,
  readPreflightCache,
} from './lib/orchestration/preflight-cache.js';
import {
  latestHeartbeatForOwner,
  currentOwner as leaseCurrentOwner,
} from './lib/orchestration/ticket-lease.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-prepare.js --epic <epicId> [--single] [--ignore-concurrency-hazards] [--steal] [--as <handle>]

Snapshots Epic #<id>, builds the wave DAG, initializes the epic-run-state
checkpoint, and prints the per-wave dispatch plan as JSON. Before any of that,
runs two fail-closed preflight guards (Story #3482): a checkout-safety check
(refuse on a dirty tree or an unexpected branch) and an Epic-lease acquisition
(refuse on a live foreign claim).

Options:
  --single                       Single-delivery prepare (Epic #4475). Short-
                                 circuits Story enumeration: seeds epic/<id>,
                                 materializes ONE worktree on it, and writes a
                                 slice-map epic-run-state (deliveryShape:
                                 "single", storyCount: 0) from the Epic body's
                                 ## Delivery Slicing table. Refuses
                                 acceptance::n-a (fail-closed). INERT until
                                 M4-B: nothing in production drives this flag
                                 yet.
  --ignore-concurrency-hazards   Bypass the cross-Story concurrency-hazard
                                 gate (Story #2297). The flag's use is
                                 recorded on the Epic checkpoint so retro
                                 tooling can flag a run that shipped
                                 despite an outstanding hazard.
  --steal                        Forcibly transfer a live foreign Epic lease
                                 to this operator instead of refusing. The
                                 takeover is logged for auditability.
  --as <handle>                  Operator identity to claim the Epic lease as.
                                 Defaults to github.operatorHandle, then the
                                 local git config user.email.
`;

/**
 * Build the production git shim the checkout-safety guard reads through. Pure
 * `git` subprocess wrappers over `cwd`; injected as a seam so the unit suite
 * can substitute an in-memory shim.
 *
 * @param {string} cwd
 * @returns {{ statusPorcelain: () => { dirty: boolean, entries: string }, currentBranch: () => string|null }}
 */
function createGitShim(cwd) {
  return {
    statusPorcelain() {
      const res = gitSpawn(cwd, 'status', '--porcelain');
      if (res.status !== 0) {
        throw new Error(
          `[epic-deliver] Failed to read git status: ${res.stderr || '(no stderr)'}`,
        );
      }
      const entries = res.stdout ?? '';
      return { dirty: entries.length > 0, entries };
    },
    currentBranch() {
      return gitCurrentBranch(cwd);
    },
  };
}

/**
 * Resolve the local `git config user.email` as the last-resort operator
 * identity. Returns null when git is unavailable or the value is unset.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveGitUserEmail(cwd) {
  const res = gitSpawn(cwd, 'config', 'user.email');
  if (res.status !== 0) return null;
  const value = (res.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * End-to-end prepare. DI-friendly: tests pass `injectedProvider` and skip the
 * real GitHub round-trips.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   storyCount: number,
 *   concurrencyCap: number,
 *   stories: Array<{ storyId: number, title: string, worktree?: string }>,
 *   checkpointInitializedAt: string,
 * }>}
 */
/**
 * Run the fail-closed preflight guards (Story #3482): refuse on a
 * dirty/foreign-branch checkout and on a live foreign Epic lease, BEFORE any
 * snapshot or git mutation. No-op when guards are suppressed. The guards are
 * skipped when `skipPreflightGuards` is set, OR — implicitly — when a caller
 * injects a provider but no git seam (the signature of the prepare-runner
 * unit tests that drive an in-memory provider and never stand up a tree). The
 * real CLI path injects neither, so the guards always run for an
 * operator-driven invocation. Story #4075 — extracted from
 * `runEpicDeliverPrepare`.
 */
async function runPreflightGuardsForPrepare({
  epicId,
  cwd,
  config,
  provider,
  injectedProvider,
  injectedGit,
  asOperator,
  steal,
  leaseHeartbeatAt,
  leaseNow,
  skipPreflightGuards,
}) {
  const guardsSuppressed =
    skipPreflightGuards || (Boolean(injectedProvider) && !injectedGit);
  if (guardsSuppressed) return;

  const guardCwd = cwd ?? process.cwd();
  const git = injectedGit ?? createGitShim(guardCwd);
  const baseBranch = config.project?.baseBranch ?? 'main';
  const expectedBranch = [getEpicBranch(epicId), baseBranch];
  const operator =
    resolveOperator({
      asFlag: asOperator,
      config,
      gitUserEmail: injectedGit ? undefined : resolveGitUserEmail(guardCwd),
    }) ?? null;

  // Liveness seam: a foreign claim is only "live" (and so refuses) when the
  // claim *owner* has a recent `story.heartbeat`. Without this the lease
  // guard is inert — every foreign claim looks stale and gets silently
  // reclaimed (audit #3513). Read the Epic's current assignee (the claim
  // owner) and resolve that owner's latest heartbeat from the Epic lifecycle
  // ledger via the shared resolver. Tests may inject `leaseHeartbeatAt`
  // directly (any value, including null) to bypass the ledger read.
  let heartbeatAt = leaseHeartbeatAt;
  if (heartbeatAt === undefined) {
    const epicTicket = await provider.getTicket(epicId);
    const claimOwner = leaseCurrentOwner(epicTicket?.assignees);
    heartbeatAt = claimOwner
      ? latestHeartbeatForOwner({ epicId, owner: claimOwner, config })
      : null;
  }

  await runPrepareGuards({
    epicId,
    expectedBranch,
    git,
    provider,
    operator,
    heartbeatAt,
    steal,
    config,
    now: leaseNow,
    logger: Logger,
  });
}

/**
 * Route the Epic boot cleanup through the shared protected boot-sweep
 * engine (Story #4373). Reaps merged, done `story-*` branches left over
 * from prior runs — the protection partition skips any branch with
 * unpushed work, a dirty worktree, or a still-open parent Story, so an
 * in-flight Story is never touched. Fast-forward is off: the prepare may
 * run on the Epic branch, and the fast-forward phase would otherwise
 * check out the base branch.
 *
 * Best-effort — a sweep failure (lock contention, git/gh error) is
 * swallowed and never blocks or fails the prepare. Skipped in the same
 * injected-test shape the preflight guards use (a provider injected with
 * no git seam) so unit tests never spawn real git/gh.
 */
async function runBootSweepForPrepare({
  cwd,
  config,
  provider,
  injectedProvider,
  injectedGit,
  injectedSweep,
  skipPreflightGuards,
}) {
  const suppressed =
    skipPreflightGuards || (Boolean(injectedProvider) && !injectedGit);
  if (suppressed) return;
  try {
    await runBootSweep({
      cwd,
      include: ['story-*'],
      fastForward: false,
      injectedConfig: config,
      injectedProvider: provider,
      injectedSweep,
      logger: Logger,
    });
  } catch (err) {
    Logger.warn(
      `[epic-deliver-prepare] ⚠️ boot sweep threw (prepare continues): ${err?.message ?? err}`,
    );
  }
}

/**
 * Resolve the Epic state, preferring the preflight cache (Story #3027) and
 * falling back to a fresh snapshot + wave-DAG pass on miss or baseSha
 * mismatch. Returns `{ state, cacheStatus }`. Story #4075 — extracted from
 * `runEpicDeliverPrepare`.
 */
async function resolvePrepareState({ epicId, cwd, provider }) {
  const cached = await readPreflightCache({ epicId, cwd });
  if (cached) {
    const freshEpic = await provider.getTicket(epicId);
    const cachedStoryIds = cached.stories
      .map((s) => Number(s?.id ?? s?.number))
      .filter((id) => Number.isInteger(id) && id > 0);
    const freshStories = await Promise.all(
      cachedStoryIds.map((id) => provider.getTicket(id)),
    );
    const freshBaseSha = computeBaseSha(freshEpic, freshStories);
    if (freshBaseSha === cached.baseSha) {
      return {
        state: {
          epic: cached.epic,
          stories: cached.stories,
          waves: cached.waves,
        },
        cacheStatus: 'hit',
      };
    }
  }
  const ctx = { epicId, provider };
  let state = await runSnapshotPhase(ctx, {}, {});
  state = await runBuildWaveDagPhase(ctx, {}, state);
  return { state, cacheStatus: cached ? 'stale' : 'miss' };
}

/**
 * Evaluate the cross-Story concurrency-hazard gate (Story #2297). Throws on a
 * tripped, non-bypassed gate; warns (and returns `gate`) on a bypassed trip.
 * Story #4075 — extracted from `runEpicDeliverPrepare`.
 */
function evaluatePrepareConcurrencyGate({
  config,
  waves,
  injectedFindings,
  ignoreConcurrencyHazards,
}) {
  const findings = Array.isArray(injectedFindings) ? injectedFindings : [];
  const pendingKeys = collectPendingStoryKeys(waves);
  const pendingFindings = filterFindingsToPending(findings, pendingKeys);
  const gate = evaluateConcurrencyGate({
    findings: pendingFindings,
    policy: {
      failOnConcurrencyHazards:
        config?.delivery?.failOnConcurrencyHazards === true,
    },
    ignore: ignoreConcurrencyHazards === true,
  });
  if (gate.tripped && !gate.bypassed) {
    const ownerRepo =
      config?.github?.owner && config?.github?.repo
        ? `${config.github.owner}/${config.github.repo}`
        : undefined;
    throw new Error(renderGateErrorMessage(gate.findings, ownerRepo));
  }
  if (gate.tripped && gate.bypassed) {
    Logger.warn(
      `[epic-deliver-prepare] ⚠️  Concurrency-hazard gate bypassed via --ignore-concurrency-hazards (reason=${gate.reason}, count=${gate.findings.length}).`,
    );
  }
  return gate;
}

/**
 * Build the per-Epic docs digest and write it to
 * `<tempRoot>/epic-<id>/docs-digest.md`, returning its repo-relative path.
 * Story #4338 — the parent threads this path into every child prompt so
 * delivery sub-agents read one compact outline instead of re-ingesting the
 * full `project.docsContextFiles` set per Story.
 *
 * Keyed off the **un-defaulted** config (`config.raw`): when the operator has
 * not configured `project.docsContextFiles`, this returns `null` (no file
 * written) rather than digesting the resolver's built-in default set — the
 * digest is an opt-in surface for projects that curate their docs context.
 *
 * @param {{ epicId: number, cwd?: string, config: object }} args
 * @returns {Promise<string|null>} repo-relative digest path, or null when
 *   `project.docsContextFiles` is empty/unset (or every file is missing).
 */
async function writeDocsDigest({ epicId, cwd, config }) {
  const rawFiles = config?.raw?.project?.docsContextFiles;
  const docsContextFiles = Array.isArray(rawFiles) ? rawFiles : [];
  if (docsContextFiles.length === 0) return null;

  const paths = getPaths(config);
  const root = path.resolve(cwd ?? process.cwd());
  const docsRoot = path.resolve(root, paths.docsRoot);
  const relPath = path.join(paths.tempRoot, `epic-${epicId}`, 'docs-digest.md');
  const absPath = path.resolve(root, relPath);
  const result = await ensureDocsDigest({
    docsContextFiles,
    docsRoot,
    outputPath: absPath,
  });
  return result ? relPath : null;
}

/**
 * Thread footprint-matched **local**-lens authoring checklists into the
 * per-Story dispatch entries (Epic #4405, Story #4410). For each planned Story,
 * derive its predicted footprint from the full ticket body's `changes[]` /
 * `references[]` entries, build the budget-capped checklist payload (matched by
 * `resolveLensTier(lens) === 'local'` + `matchesAnyFilePattern` — NOT
 * `selectAudits`, so no provider or git diff runs here), and write it to
 * `<tempRoot>/epic-<id>/checklists/story-<sid>.md`. The parent threads the
 * returned repo-relative `checklistPath` into that child's maker prompt, next
 * to `docsDigestPath`; a Story that matches no local lens gets a `null` path
 * and no file.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   config: object,
 *   stories: Array<{ storyId: number, worktree?: string, title?: string }>,
 *   storyById: Map<number, object>,
 * }} args
 * @returns {Promise<Array<{ storyId: number, worktree?: string, title?: string, checklistPath: string|null }>>}
 */
export async function writeStoryChecklists({
  epicId,
  cwd,
  config,
  stories,
  storyById,
  buildPayload = buildChecklistPayload,
}) {
  const paths = getPaths(config);
  const root = path.resolve(cwd ?? process.cwd());

  return Promise.all(
    stories.map(async (entry) => {
      const ticket = storyById.get(Number(entry.storyId));
      const footprint = ticket
        ? collectStoryAssumptionEntries(ticket).map((e) => e.path)
        : [];
      const { payload } = buildPayload({ footprint, logger: Logger });
      if (!payload) return { ...entry, checklistPath: null };

      const relPath = path.join(
        paths.tempRoot,
        `epic-${epicId}`,
        'checklists',
        `story-${entry.storyId}.md`,
      );
      const absPath = path.resolve(root, relPath);
      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, payload, 'utf-8');
      return { ...entry, checklistPath: relPath };
    }),
  );
}

/**
 * Seed `epic/<id>` and materialize the ONE worktree the single-delivery
 * executor walks — the single-delivery counterpart to `single-story-init.js`'s
 * single-worktree seed (Epic #4475). Fetches origin so remote-tracking refs
 * are authoritative, publishes the Epic integration branch via the shared
 * `ensureEpicBranchRef` seeder (the same helper `branch-initializer.js` uses),
 * then adds a worktree at `.worktrees/epic-<id>/` on `epic/<id>` — idempotent,
 * reused on a re-prepare. When worktree isolation is off it checks the branch
 * out on the main tree instead (mirroring `provisionWorktree`).
 *
 * Skipped in the same injected-test shape the preflight guards use (a provider
 * injected with no git seam) so unit tests never spawn real git.
 *
 * @param {{
 *   epicId: number,
 *   cwd: string,
 *   baseBranch: string,
 *   worktreeEnabled: boolean,
 *   progress?: (stage: string, msg: string) => void,
 * }} args
 * @returns {{ epicBranch: string, workCwd: string, worktreeCreated: boolean }}
 */
export function provisionEpicWorktree({
  epicId,
  cwd,
  baseBranch,
  worktreeEnabled,
  progress = () => {},
}) {
  const epicBranch = getEpicBranch(epicId);

  // Fetch origin so `ensureEpicBranchRef` can read remote-tracking refs
  // instead of a second network round-trip (mirrors materializeBaseBranch).
  cachedGitFetch(cwd, 'origin');
  ensureEpicBranchRef(epicBranch, baseBranch, cwd, { progress });

  if (!worktreeEnabled) {
    // Single-tree mode: check out the Epic integration branch in place.
    gitSync(cwd, 'checkout', epicBranch);
    progress('WORKTREE', `Checked out ${epicBranch} on the main tree.`);
    return { epicBranch, workCwd: cwd, worktreeCreated: false };
  }

  const worktreeRoot = path.join(cwd, '.worktrees');
  const wtPath = path.join(worktreeRoot, `epic-${epicId}`);
  fs.mkdirSync(worktreeRoot, { recursive: true });

  const listed = gitSpawn(cwd, 'worktree', 'list', '--porcelain');
  const alreadyPresent =
    listed.status === 0 && (listed.stdout ?? '').includes(wtPath);
  if (alreadyPresent) {
    progress('WORKTREE', `♻️  Reusing worktree: ${wtPath}`);
    return { epicBranch, workCwd: wtPath, worktreeCreated: false };
  }

  const res = gitSpawn(cwd, 'worktree', 'add', wtPath, epicBranch);
  if (res.status !== 0) {
    const stderr = res.stderr || res.stdout || '';
    if (/already (exists|checked out)/.test(stderr)) {
      progress('WORKTREE', `♻️  Reusing worktree (race): ${wtPath}`);
      return { epicBranch, workCwd: wtPath, worktreeCreated: false };
    }
    throw new Error(
      `epic-deliver-prepare --single: git worktree add failed for epic-${epicId}: ${stderr}`,
    );
  }
  progress('WORKTREE', `✨ Created worktree: ${wtPath}`);
  return { epicBranch, workCwd: wtPath, worktreeCreated: true };
}

/**
 * Step 0/1 of `/deliver` for a single-delivery Epic (Epic #4475, design §S1).
 *
 * The single-delivery counterpart to `runEpicDeliverPrepare`. It short-circuits
 * Story enumeration entirely — a spec-only plan authored NO Story tickets, so
 * there is nothing to fan out. Instead it:
 *
 *   1. Refuses `acceptance::n-a` (fail-closed front gate). Under single
 *      delivery the non-waivable epic-level acceptance reconcile is the ONLY
 *      acceptance gate; an Epic that declares "no acceptance criteria" is
 *      structurally incoherent with that contract.
 *   2. Runs the same fail-closed preflight guards (checkout-safety + Epic
 *      lease) as the fan-out prepare.
 *   3. Seeds `epic/<id>` and materializes ONE worktree on it.
 *   4. Parses the Epic body's `## Delivery Slicing` table and writes an
 *      `epic-run-state` **slice map** (`deliveryShape: "single"`,
 *      `storyCount: 0`, `concurrencyCap: 1`) — idempotent + resume-preserving
 *      (a re-run keeps every already-`done` slice).
 *   5. Writes the per-Epic docs digest.
 *
 * BEHAVIOR-PRESERVING (M4-A): this function is reachable only through the
 * `--single` flag, which nothing in production drives yet (the `deliver.md`
 * router's single verdict falls through to the fan-out helper until M4-B). The
 * slice-map checkpoint round-trips but no executor consumes it here.
 *
 * @param {object} args — same DI surface as `runEpicDeliverPrepare` minus the
 *   concurrency-hazard knobs (single delivery fans out nothing to gate).
 * @returns {Promise<{
 *   epicId: number,
 *   deliveryShape: 'single',
 *   storyCount: 0,
 *   concurrencyCap: number,
 *   sliceCount: number,
 *   slices: Record<string, { status: string, title?: string }>,
 *   epicBranch: string,
 *   workCwd: string,
 *   worktreeCreated: boolean,
 *   checkpointInitializedAt: string,
 *   docsDigestPath: string|null,
 * }>}
 */
export async function runEpicDeliverPrepareSingle({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
  asOperator,
  steal = false,
  injectedGit,
  leaseHeartbeatAt,
  leaseNow,
  skipPreflightGuards = false,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverPrepareSingle: --epic must be a positive integer',
    );
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  if (!config.github) {
    throw new Error(
      'runEpicDeliverPrepareSingle: no github block in .agentrc.json',
    );
  }
  const provider = injectedProvider ?? createProvider(config);
  // Single delivery collapses the whole Epic into ONE guarded in-session slice
  // walk — the concurrency cap is 1 by definition (nothing fans out).
  const concurrencyCap = 1;

  const epic = await provider.getTicket(epicId);
  const labels = Array.isArray(epic?.labels) ? epic.labels : [];
  if (!labels.includes(TYPE_LABELS.EPIC)) {
    throw new Error(
      `runEpicDeliverPrepareSingle: #${epicId} is not a ${TYPE_LABELS.EPIC} (labels: ${labels.join(', ') || 'none'}).`,
    );
  }

  // Fail-closed front gate (design §"Non-waivable epic reconcile"): under
  // single delivery the epic-level acceptance reconcile is the ONLY acceptance
  // gate that runs — there is no per-Story self-eval critic tier behind it. An
  // Epic labelled `acceptance::n-a` (no acceptance criteria) is therefore
  // structurally incoherent with single delivery: it would waive the sole
  // gate. Refuse loudly instead of silently shipping ungated.
  if (labels.includes(ACCEPTANCE_NA)) {
    throw new Error(
      `[epic-deliver-prepare] BLOCKER: Epic #${epicId} carries ${ACCEPTANCE_NA}, ` +
        'but single delivery makes the non-waivable epic-level acceptance ' +
        'reconcile the ONLY acceptance gate — an Epic with no acceptance ' +
        'criteria would ship ungated. Remove the label (author an ' +
        '## Acceptance Table), or re-plan the Epic as fan-out.',
    );
  }

  await runPreflightGuardsForPrepare({
    epicId,
    cwd,
    config,
    provider,
    injectedProvider,
    injectedGit,
    asOperator,
    steal,
    leaseHeartbeatAt,
    leaseNow,
    skipPreflightGuards,
  });

  const baseBranch = config.project?.baseBranch ?? 'main';
  const runtime = resolveRuntime({ config });

  // Seed epic/<id> + materialize the one worktree. Skipped in the injected-
  // test shape (a provider injected with no git seam) so unit tests never
  // spawn real git — matching the preflight-guard suppression rule.
  const worktreeSuppressed =
    skipPreflightGuards || (Boolean(injectedProvider) && !injectedGit);
  let epicBranch = getEpicBranch(epicId);
  let workCwd = cwd ?? process.cwd();
  let worktreeCreated = false;
  if (!worktreeSuppressed) {
    ({ epicBranch, workCwd, worktreeCreated } = provisionEpicWorktree({
      epicId,
      cwd: cwd ?? process.cwd(),
      baseBranch,
      worktreeEnabled: runtime.worktreeEnabled,
      progress: (stage, msg) =>
        Logger.info(`[epic-deliver-prepare:single] ${stage} ${msg}`),
    }));
  }

  // Parse the Epic body's `## Delivery Slicing` table — the single mode's
  // audit trail and the source of the slice map. A missing/unparseable table
  // yields an empty slice set (the executor has nothing to walk); that is a
  // plan-quality problem surfaced downstream, not a prepare-time throw.
  const slices = parseDeliverySlicingTable(epic?.body ?? '') ?? [];

  const checkpointState = await initializeEpicRunStateSingle({
    provider,
    epicId,
    slices,
    concurrencyCap,
  });

  const docsDigestPath = await writeDocsDigest({ epicId, cwd, config });

  return {
    epicId,
    deliveryShape: 'single',
    storyCount: 0,
    concurrencyCap,
    sliceCount: Object.keys(checkpointState.slices ?? {}).length,
    slices: checkpointState.slices ?? {},
    epicBranch,
    workCwd,
    worktreeCreated,
    checkpointInitializedAt:
      checkpointState.startedAt ??
      checkpointState.lastUpdatedAt ??
      new Date().toISOString(),
    docsDigestPath,
  };
}

export async function runEpicDeliverPrepare({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
  injectedFindings,
  ignoreConcurrencyHazards = false,
  steal = false,
  asOperator,
  injectedGit,
  injectedSweep,
  leaseHeartbeatAt,
  leaseNow,
  skipPreflightGuards = false,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverPrepare: --epic must be a positive integer',
    );
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  if (!config.github) {
    throw new Error('runEpicDeliverPrepare: no github block in .agentrc.json');
  }
  const provider = injectedProvider ?? createProvider(config);
  const { deliverRunner } = getRunners(config);
  const concurrencyCap = deliverRunner.concurrencyCap;

  await runPreflightGuardsForPrepare({
    epicId,
    cwd,
    config,
    provider,
    injectedProvider,
    injectedGit,
    asOperator,
    steal,
    leaseHeartbeatAt,
    leaseNow,
    skipPreflightGuards,
  });

  await runBootSweepForPrepare({
    cwd,
    config,
    provider,
    injectedProvider,
    injectedGit,
    injectedSweep,
    skipPreflightGuards,
  });

  const { state, cacheStatus } = await resolvePrepareState({
    epicId,
    cwd,
    provider,
  });

  const gate = evaluatePrepareConcurrencyGate({
    config,
    waves: state.waves,
    injectedFindings,
    ignoreConcurrencyHazards,
  });

  // Flatten the wave-DAG into the open Story set. The ready-set runtime
  // re-derives readiness from live labels on every tick, so the checkpoint
  // stores only the Story set in scope (seeded at `pending`) and the global
  // in-flight cap — no wave grouping, no `currentWave`, no `totalWaves`.
  const openStories = state.waves.flat();
  const checkpointState = await initializeEpicRunState({
    provider,
    epicId,
    storyIds: openStories,
    concurrencyCap,
  });

  // Resolve per-Story worktree paths via the launcher so the slash command
  // has a deterministic `{ storyId, worktree, title }` list to seed Agent
  // dispatch from. This is a dispatch *hint* — the ready-set tick decides
  // which Stories to dispatch on each beat; the prepare only enumerates them.
  const launcher = new StoryLauncher({ concurrencyCap });
  const plannedStories = launcher.planWave(openStories).map((entry, i) => ({
    ...entry,
    title: openStories[i]?.title ?? '',
  }));

  // Thread footprint-matched local-lens authoring checklists into each Story's
  // dispatch entry (Story #4410). Keyed off the full discovered tickets (which
  // carry the `changes[]`/`references[]` bodies the footprint is derived from);
  // a Story that matches no local lens gets a `null` checklistPath.
  const storyById = new Map(
    (state.stories ?? []).map((t) => [Number(t.id ?? t.number), t]),
  );
  const stories = await writeStoryChecklists({
    epicId,
    cwd,
    config,
    stories: plannedStories,
    storyById,
  });

  // Persist the `--ignore-concurrency-hazards` flag on the checkpoint so
  // retro tooling can flag a run that shipped despite an outstanding hazard
  // (the warning above is one-shot; the checkpoint is durable).
  if (gate.bypassed) {
    await writeEpicRunState({
      provider,
      epicId,
      state: { ...checkpointState, ignoreConcurrencyHazards: true },
    });
  }

  const docsDigestPath = await writeDocsDigest({ epicId, cwd, config });

  return {
    epicId,
    storyCount: openStories.length,
    concurrencyCap,
    stories,
    checkpointInitializedAt:
      checkpointState.startedAt ??
      checkpointState.lastUpdatedAt ??
      new Date().toISOString(),
    concurrencyHazardsBypassed: gate.bypassed,
    preflightCache: cacheStatus,
    docsDigestPath,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      single: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      'ignore-concurrency-hazards': { type: 'boolean', default: false },
      steal: { type: 'boolean', default: false },
      as: { type: 'string' },
    },
    strict: false,
  });

  if (values.help) {
    Logger.info(HELP);
    return;
  }
  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    Logger.error('[epic-deliver-prepare] ERROR: --epic <epicId> is required.');
    Logger.error(HELP);
    process.exit(2);
  }

  const asOperator = typeof values.as === 'string' ? values.as : undefined;
  const steal = values.steal === true;

  const result =
    values.single === true
      ? await runEpicDeliverPrepareSingle({ epicId, asOperator, steal })
      : await runEpicDeliverPrepare({
          epicId,
          ignoreConcurrencyHazards:
            values['ignore-concurrency-hazards'] === true,
          steal,
          asOperator,
        });
  Logger.info(JSON.stringify(result, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-prepare' });
