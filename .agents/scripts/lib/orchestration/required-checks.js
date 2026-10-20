/**
 * GitHub's per-PR required-check attribution (GraphQL `isRequired`, or over
 * the REST transport the base's rulesets plus classic protection), not
 * `.agentrc` requiredChecks, which are local command names.
 */

import { GhNotFoundError, prTransportOf } from '../gh-exec.js';
import { parseApiJson, readBranchRules } from '../gh-pr-rest.js';
import {
  deriveRequiredRunEvidence,
  failingChecksBlockMerge,
  isRunInFlight,
  MERGE_WAIT_GH_TIMEOUT_MS,
  readRunName,
  redConclusionOf,
} from './merge-poll.js';

/**
 * A required run is red and no re-run of that same check is in flight.
 *
 * @param {Array<object>} statusCheckRollup non-empty
 * @param {Set<string>} requiredNames
 */
function deriveAttributedEvidence(statusCheckRollup, requiredNames) {
  const failedRequired = new Set();
  for (const check of statusCheckRollup) {
    const name = readRunName(check);
    if (name && requiredNames.has(name) && redConclusionOf(check)) {
      failedRequired.add(name);
    }
  }
  let requiredRunInFlight = false;
  let runInFlight = false;
  for (const check of statusCheckRollup) {
    if (!isRunInFlight(check)) continue;
    runInFlight = true;
    if (failedRequired.has(readRunName(check))) requiredRunInFlight = true;
  }
  return {
    requiredRunFailed: failedRequired.size > 0,
    requiredRunInFlight,
    runInFlight,
    attribution: 'github',
  };
}

const REQUIRED_CHECKS_QUERY =
  'query($id: ID!, $n: Int!) { node(id: $id) { ... on PullRequest { ' +
  'commits(last: 1) { nodes { commit { statusCheckRollup { ' +
  'contexts(first: 100) { nodes { __typename ' +
  '... on CheckRun { name isRequired(pullRequestNumber: $n) } ' +
  '... on StatusContext { context isRequired(pullRequestNumber: $n) } ' +
  '} } } } } } } } }';

/**
 * @param {object|string} result `gh api graphql` output
 * @returns {Set<string>}
 */
function parseRequiredNames(result) {
  const text = typeof result === 'string' ? result : result?.stdout;
  const parsed = JSON.parse(String(text ?? ''));
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new Error('graphql errors reading required checks');
  }
  const nodes =
    parsed?.data?.node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
      ?.nodes;
  if (!Array.isArray(nodes)) throw new Error('required-check contexts absent');
  const names = new Set();
  for (const node of nodes) {
    const name = readRunName(node);
    if (node?.isRequired === true && name) names.add(name);
  }
  return names;
}

/**
 * Classic branch protection's required contexts; no protection (404) is none.
 *
 * @returns {Promise<string[]>}
 */
async function readProtectionContexts({ api, base, timeoutMs }) {
  try {
    const body = parseApiJson(
      await api({
        method: 'GET',
        endpoint: `repos/{owner}/{repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`,
        execOpts: { timeoutMs },
      }),
    );
    return [
      ...(body?.contexts ?? []),
      ...(body?.checks ?? []).map((check) => check?.context),
    ];
  } catch (err) {
    if (err instanceof GhNotFoundError) return [];
    throw err;
  }
}

/**
 * REST required names: `required_status_checks` rules on the base, unioned
 * with classic protection.
 *
 * @returns {Promise<Set<string>>}
 */
async function readRequiredNamesRest({ prNumber, gh, timeoutMs }) {
  const view = await gh.pr.view(String(prNumber), ['baseRefName']);
  const base = view?.baseRefName;
  if (!base) throw new Error('PR base branch unreadable');
  const [rules, contexts] = await Promise.all([
    readBranchRules({ api: gh.api, base, timeoutMs }),
    readProtectionContexts({ api: gh.api, base, timeoutMs }),
  ]);
  const names = new Set(contexts.filter(Boolean));
  for (const rule of rules) {
    if (rule?.type !== 'required_status_checks') continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (check?.context) names.add(check.context);
    }
  }
  return names;
}

/** @returns {Promise<Set<string>>} */
async function readRequiredNamesGraphql({ prNodeId, prNumber, gh, timeoutMs }) {
  return parseRequiredNames(
    await gh.api({
      method: 'POST',
      endpoint: 'graphql',
      body: {
        query: REQUIRED_CHECKS_QUERY,
        variables: { id: prNodeId, n: Number(prNumber) },
      },
      execOpts: { timeoutMs },
    }),
  );
}

/** Per-head cache: required attribution is read at most once per PR head. */
const requiredNamesCache = new Map();

/**
 * Required check names, cached per PR head. `null` on any failure.
 *
 * @param {{ prNodeId?: string, prNumber: number|string, headSha?: string,
 *   gh: { api: Function }, timeoutMs?: number }} args
 * @returns {Promise<Set<string>|null>}
 */
async function readRequiredCheckNames({
  prNodeId,
  prNumber,
  headSha,
  gh,
  timeoutMs = MERGE_WAIT_GH_TIMEOUT_MS,
}) {
  if (!prNodeId || !headSha) return null;
  const key = `${prNodeId}@${headSha}`;
  if (requiredNamesCache.has(key)) return requiredNamesCache.get(key);
  try {
    const read =
      (await prTransportOf(gh)) === 'rest'
        ? readRequiredNamesRest
        : readRequiredNamesGraphql;
    const names = await read({ prNodeId, prNumber, gh, timeoutMs });
    requiredNamesCache.set(key, names);
    return names;
  } catch {
    return null;
  }
}

/**
 * Scoped evidence when a red gates the merge and attribution reads; else
 * the unscoped rule.
 *
 * @param {{ view?: object, checksStatus?: string, prNumber: number|string,
 *   gh: object, ghTimeoutMs?: number, readFn?: Function }} args
 * @returns {Promise<object|null>}
 */
export async function readProbeRunEvidence({
  view,
  checksStatus,
  prNumber,
  gh,
  ghTimeoutMs,
  readFn = readRequiredCheckNames,
}) {
  const rollup = view?.statusCheckRollup;
  const gated = failingChecksBlockMerge({
    checksStatus,
    mergeStateStatus: view?.mergeStateStatus,
  });
  const names = gated
    ? await readFn({
        prNodeId: view?.id,
        prNumber,
        headSha: view?.headRefOid,
        gh,
        timeoutMs: ghTimeoutMs,
      })
    : null;
  if (names instanceof Set && Array.isArray(rollup) && rollup.length > 0) {
    return deriveAttributedEvidence(rollup, names);
  }
  return deriveRequiredRunEvidence(rollup);
}
