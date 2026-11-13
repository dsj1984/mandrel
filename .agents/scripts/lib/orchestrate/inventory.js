/**
 * inventory.js — the bounded GitHub and git reads behind
 * `orchestrate-inventory.js`, normalised into one snapshot for `classify.js`.
 * One paginated PR query, one workflow-run listing, the base's latest checks;
 * never a job log. Over repo-scoped REST the merge queue is unreadable, so
 * the snapshot says so instead of guessing.
 */

import { spawnCapture } from '../child-exec.js';
import { gh as defaultGh, prTransportOf } from '../gh-exec.js';
import { parseApiJson } from '../gh-pr-rest.js';
import { gitSpawn, parseStoryBranch } from '../git-utils.js';
import { classifyRollupEntry } from '../orchestration/check-state.js';
import { isRunInFlight, readRunName } from '../orchestration/merge-poll.js';
import { parseGraphqlData } from '../orchestration/merge-queue.js';
import { readBaseRequiredNames } from '../orchestration/required-checks.js';
import { buildEnvelope } from './classify.js';
import { resolveConflict } from './conflicts.js';
import {
  landedSince,
  lastSweep,
  readLedger,
  recordSweep,
  sweepChanges,
} from './ledger.js';

const REPO = 'repos/{owner}/{repo}';
const PAGE = 25;
// shortcut: stops at 4 pages (100 open PRs); page further if a fleet outgrows it.
const MAX_PAGES = 4;
const MERGED_LIMIT = 30;

const CHECK_FIELDS =
  '__typename ... on CheckRun { name status conclusion startedAt completedAt annotations(first: 1) { nodes { message } } } ' +
  '... on StatusContext { context state createdAt }';

const INVENTORY_QUERY =
  'query($owner: String!, $repo: String!, $base: String!, $after: String) { repository(owner: $owner, name: $repo) { ' +
  `ref(qualifiedName: $base) { target { ... on Commit { oid statusCheckRollup { contexts(first: 60) { nodes { ${CHECK_FIELDS} } } } } } } ` +
  `pullRequests(states: OPEN, first: ${PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ` +
  'number isDraft headRefName headRefOid mergeable isInMergeQueue author { login } autoMergeRequest { enabledAt } ' +
  'labels(first: 10) { nodes { name } } files(first: 100) { totalCount nodes { path } } ' +
  'closingIssuesReferences(first: 3) { nodes { number assignees(first: 5) { nodes { login } } } } ' +
  'timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { __typename ' +
  '... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { createdAt reason beforeCommit { oid } } } } ' +
  `commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 60) { nodes { ${CHECK_FIELDS} } } } } } } ` +
  '} } } }';

const latest = (...times) => {
  const ms = times.map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
  return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
};

/** Outcomes that are a real failure; the close-path merge wait reads these differently. */
const RED_OUTCOMES = new Set(['failure', 'timed_out']);
/** A run that never passed and never failed: not green, not the owner's red. */
const HALTED_OUTCOMES = new Set(['cancelled', 'stale', 'action_required']);

/** A rollup node (GraphQL, or REST mapped to the same shape) as a terse check. */
function normalizeCheck(node) {
  const status = String(node?.status ?? '').toUpperCase();
  let phase = 'done';
  if (isRunInFlight(node))
    phase = status === 'IN_PROGRESS' ? 'running' : 'queued';
  const outcome = classifyRollupEntry(node);
  return {
    name: readRunName(node) ?? '',
    phase,
    red: RED_OUTCOMES.has(outcome),
    halted: HALTED_OUTCOMES.has(outcome),
    note: node?.annotations?.nodes?.[0]?.message ?? node?.output?.title ?? null,
    at: latest(node?.startedAt, node?.completedAt, node?.createdAt),
  };
}

const nodesOf = (conn) => (Array.isArray(conn?.nodes) ? conn.nodes : []);

function queueEventOf(node) {
  if (!node) return null;
  const removed = node.__typename === 'RemovedFromMergeQueueEvent';
  return {
    type: removed ? 'removed' : 'added',
    at: node.createdAt ?? null,
    reason: removed ? (node.reason ?? null) : null,
    headSha: removed ? (node.beforeCommit?.oid ?? null) : null,
  };
}

function assigneesFor(storyId, issues) {
  const issue = issues.find((i) => i.number === storyId);
  return nodesOf(issue?.assignees).map((a) => a.login);
}

/** A GraphQL PR node as a snapshot row. */
function normalizeGraphqlPr(node) {
  const commit = nodesOf(node.commits)[0]?.commit ?? {};
  const checks = nodesOf(commit.statusCheckRollup?.contexts).map(
    normalizeCheck,
  );
  const storyId = parseStoryBranch(node.headRefName);
  return {
    number: node.number,
    storyId,
    author: node.author?.login ?? null,
    assignees: storyId
      ? assigneesFor(storyId, nodesOf(node.closingIssuesReferences))
      : [],
    headSha: node.headRefOid ?? null,
    labels: nodesOf(node.labels).map((l) => l.name),
    draft: node.isDraft === true,
    conflicting: node.mergeable === 'CONFLICTING',
    autoMerge: Boolean(node.autoMergeRequest),
    inQueue: node.isInMergeQueue === true,
    queueEvent: queueEventOf(nodesOf(node.timelineItems).at(-1)),
    checks,
    paths: nodesOf(node.files).map((f) => f.path),
    pathCount: node.files?.totalCount ?? 0,
    pushedAt: commit.committedDate ?? null,
    activityAt: latest(commit.committedDate, ...checks.map((c) => c.at)),
  };
}

async function readGraphql({ gh, owner, repo, base }) {
  const prs = [];
  let baseCommit = null;
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = parseGraphqlData(
      await gh.api({
        method: 'POST',
        endpoint: 'graphql',
        body: {
          query: INVENTORY_QUERY,
          variables: { owner, repo, base, after },
        },
      }),
    );
    baseCommit ??= data?.repository?.ref?.target ?? null;
    const conn = data?.repository?.pullRequests;
    prs.push(...nodesOf(conn).map(normalizeGraphqlPr));
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return {
    base: {
      branch: base,
      sha: baseCommit?.oid ?? null,
      checks: nodesOf(baseCommit?.statusCheckRollup?.contexts).map(
        normalizeCheck,
      ),
    },
    prs,
  };
}

const restGet = async (gh, endpoint) =>
  parseApiJson(await gh.api({ method: 'GET', endpoint }));

/** A REST check run in the rollup-node shape `normalizeCheck` reads. */
const restCheck = (run) => ({
  name: run?.name,
  status: String(run?.status ?? '').toUpperCase(),
  conclusion: String(run?.conclusion ?? '').toUpperCase(),
  startedAt: run?.started_at,
  completedAt: run?.completed_at,
  output: run?.output,
});

async function readRestPr(gh, pull) {
  const storyId = parseStoryBranch(pull.head?.ref);
  const [detail, runs, files, issue] = await Promise.all([
    restGet(gh, `${REPO}/pulls/${pull.number}`),
    restGet(gh, `${REPO}/commits/${pull.head?.sha}/check-runs?per_page=100`),
    restGet(gh, `${REPO}/pulls/${pull.number}/files?per_page=100`),
    storyId ? restGet(gh, `${REPO}/issues/${storyId}`) : null,
  ]);
  const checks = (runs?.check_runs ?? []).map(restCheck).map(normalizeCheck);
  const paths = (Array.isArray(files) ? files : []).map((f) => f.filename);
  return {
    number: pull.number,
    storyId,
    author: pull.user?.login ?? null,
    assignees: (issue?.assignees ?? []).map((a) => a.login),
    headSha: pull.head?.sha ?? null,
    labels: (pull.labels ?? []).map((l) => l.name),
    draft: pull.draft === true,
    conflicting: detail?.mergeable_state === 'dirty',
    autoMerge: Boolean(pull.auto_merge),
    inQueue: null,
    queueEvent: null,
    checks,
    paths,
    pathCount: detail?.changed_files ?? paths.length,
    pushedAt: pull.updated_at ?? null,
    activityAt: latest(pull.updated_at, ...checks.map((c) => c.at)),
  };
}

async function readRest({ gh, base }) {
  const [pulls, baseRuns] = await Promise.all([
    restGet(gh, `${REPO}/pulls?state=open&per_page=100`),
    restGet(
      gh,
      `${REPO}/commits/${encodeURIComponent(base)}/check-runs?per_page=100`,
    ),
  ]);
  const prs = [];
  for (const pull of Array.isArray(pulls) ? pulls : [])
    prs.push(await readRestPr(gh, pull));
  const runs = baseRuns?.check_runs ?? [];
  return {
    base: {
      branch: base,
      sha: runs[0]?.head_sha ?? null,
      checks: runs.map(restCheck).map(normalizeCheck),
    },
    prs,
  };
}

const QUEUED_RUN = new Set(['queued', 'waiting', 'pending', 'requested']);

async function readRunners(gh, now) {
  const body = await restGet(gh, `${REPO}/actions/runs?per_page=100`);
  const runs = body?.workflow_runs ?? [];
  const queued = runs.filter((r) => QUEUED_RUN.has(r.status));
  const oldest = Math.min(
    ...queued.map((r) => Date.parse(r.created_at)).filter(Number.isFinite),
  );
  return {
    queued: queued.length,
    inProgress: runs.filter((r) => r.status === 'in_progress').length,
    oldestWaitMin: Number.isFinite(oldest)
      ? Math.round((now - oldest) / 60_000)
      : null,
  };
}

async function readMerged(gh, base, since) {
  const rows = await gh.pr.list(
    ['--state', 'merged', '--base', base, '--limit', String(MERGED_LIMIT)],
    ['number', 'headRefName', 'mergedAt'],
  );
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => Date.parse(r.mergedAt ?? '') > Date.parse(since))
    .map((r) => ({
      number: r.number,
      storyId: parseStoryBranch(r.headRefName),
    }));
}

/** A failed optional read degrades to `fallback` and names itself. */
async function settle(degraded, name, read, fallback) {
  try {
    return await read();
  } catch {
    degraded.push(name);
    return fallback;
  }
}

/**
 * Every GitHub read, normalised. `since` (an ISO time) asks for the PRs
 * merged after it; null skips that read.
 */
async function readSnapshot({ gh, owner, repo, base, since = null, now }) {
  const degraded = [];
  const rest = (await prTransportOf(gh)) === 'rest';
  if (rest) degraded.push('merge-queue');
  const core = rest
    ? await readRest({ gh, base })
    : await readGraphql({ gh, owner, repo, base });
  const required = await settle(
    degraded,
    'required-checks',
    () => readBaseRequiredNames({ api: gh.api, base }),
    null,
  );
  return {
    ...core,
    required: required?.size ? [...required] : null,
    queueReadable: !rest,
    runners: await settle(
      degraded,
      'runners',
      () => readRunners(gh, now),
      null,
    ),
    merged: since
      ? await settle(degraded, 'landed', () => readMerged(gh, base, since), [])
      : [],
    degraded,
  };
}

/** `delivery.orchestrate`, malformed commands dropped. */
function orchestrateConfig(config) {
  const block = config?.delivery?.orchestrate ?? {};
  const command = (c) =>
    typeof c?.cmd === 'string' && c.cmd
      ? { cmd: c.cmd, args: c.args ?? [] }
      : null;
  const veto = command(block.releaseVeto);
  return {
    requeueCommand: command(block.requeueCommand),
    releaseVeto:
      veto && block.releaseVeto.prLabel
        ? { ...veto, prLabel: block.releaseVeto.prLabel }
        : null,
  };
}

/** The veto holds when its command exits non-zero (or cannot run). */
const runVetoCommand = ({ cmd, args }, cwd) =>
  spawnCapture(cmd, args, { cwd }).status !== 0;

/** Whether `delivery.orchestrate.releaseVeto` holds a PR carrying `labels`. */
export function releaseVetoHolds({
  config,
  labels,
  cwd,
  runVeto = runVetoCommand,
}) {
  const { releaseVeto } = orchestrateConfig(config);
  return Boolean(
    releaseVeto &&
      labels.includes(releaseVeto.prLabel) &&
      runVeto(releaseVeto, cwd),
  );
}

/**
 * One sweep: read, resolve conflicts and the veto, classify, and with a
 * run id append the sweep and fill `changes[]`.
 */
export async function runInventory({
  config,
  cwd,
  runId = null,
  ledgerFile = null,
  gh = defaultGh,
  now = Date.now(),
  spawn = gitSpawn,
  runVeto = runVetoCommand,
}) {
  const base = config?.project?.baseBranch ?? 'main';
  const records = ledgerFile ? readLedger(ledgerFile) : [];
  const since = runId
    ? (landedSince(records) ?? new Date(now).toISOString())
    : null;
  const snapshot = await readSnapshot({
    gh,
    owner: config?.github?.owner,
    repo: config?.github?.repo,
    base,
    since,
    now,
  });
  for (const pr of snapshot.prs) {
    if (pr.conflicting)
      pr.conflict = resolveConflict({
        cwd,
        base,
        number: pr.number,
        headSha: pr.headSha,
        spawn,
      });
  }
  const { requeueCommand, releaseVeto } = orchestrateConfig(config);
  const vetoNeeded =
    releaseVeto &&
    snapshot.prs.some((pr) => pr.labels.includes(releaseVeto.prLabel));
  const envelope = buildEnvelope(snapshot, {
    now,
    requeueCommand,
    vetoLabel: releaseVeto?.prLabel ?? null,
    vetoHeld: vetoNeeded ? runVeto(releaseVeto, cwd) : false,
  });
  if (ledgerFile) {
    const states = Object.fromEntries(
      envelope.prs.map((pr) => [pr.number, pr.state]),
    );
    envelope.changes = sweepChanges(lastSweep(records)?.states ?? null, states);
    recordSweep({ file: ledgerFile, states, merged: snapshot.merged, now });
  }
  return envelope;
}

/** One line per PR, for an operator reading the terminal. */
export function renderInventory(envelope) {
  const lines = [
    `base ${envelope.base.branch}@${envelope.base.sha ?? '?'}${envelope.base.red.length ? ` red: ${envelope.base.red.join('; ')}` : ''}`,
  ];
  for (const pr of envelope.prs) {
    const owner = pr.storyId ? `Story #${pr.storyId}` : `@${pr.author ?? '?'}`;
    lines.push(
      `#${pr.number} ${pr.state} ${owner}${pr.red ? ` — ${pr.red.join('; ')}` : ''}`,
    );
  }
  for (const c of envelope.changes)
    lines.push(
      `changed #${c.number}: ${c.from ?? '(new)'} -> ${c.to ?? '(gone)'}`,
    );
  if (envelope.degraded.length)
    lines.push(`degraded: ${envelope.degraded.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
