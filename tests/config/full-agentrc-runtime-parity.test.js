/**
 * Reference ↔ runtime accessor parity (claimed by lib/config/defaults.js).
 *
 * `.agents/docs/agentrc-reference.json` is the sync/explain defaults SSOT via
 * `getAgentrcDefaults()`. Runtime accessors under `lib/config/*.js` must
 * ship the same leaf values for every path they resolve — otherwise
 * `/mandrel-update` and `mandrel explain` lie about what an omitted key means.
 *
 * Agent-read-only / inventory-only keys (workflows honor them; JS does not
 * resolve a parallel DEFAULT constant) are listed in `AGENT_READ_ONLY_PREFIXES`
 * and skipped for strict equality.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getAgentrcDefaults,
  lookupPath,
} from '../../.agents/scripts/lib/config/defaults.js';
import { ACCEPTANCE_EVAL_DEFAULTS } from '../../.agents/scripts/lib/config/acceptance-eval.js';
import { CI_DELIVERY_DEFAULTS } from '../../.agents/scripts/lib/config/ci.js';
import { COMMANDS_DEFAULTS } from '../../.agents/scripts/lib/config/commands.js';
import { DELIVERY_ROUTING_DEFAULTS } from '../../.agents/scripts/lib/config/delivery-routing.js';
import {
  DEFAULT_REQUIRED_CHECKS,
  BRANCH_PROTECTION_DEFAULTS,
  MERGE_METHODS_DEFAULTS,
  NOTIFICATIONS_DEFAULTS,
} from '../../.agents/scripts/lib/config/github.js';
import { LIMITS_DEFAULTS } from '../../.agents/scripts/lib/config/limits.js';
import { PATHS_DEFAULTS } from '../../.agents/scripts/lib/config/paths.js';
import {
  BASELINE_EPSILON_DEFAULTS,
  CODING_GUARDRAILS_DEFAULTS,
  COVERAGE_GATE_DEFAULTS,
  CRAP_GATE_DEFAULTS,
  MAINTAINABILITY_GATE_DEFAULTS,
} from '../../.agents/scripts/lib/config/quality.js';
import {
  DEFAULT_CODE_REVIEW,
  getRunners,
} from '../../.agents/scripts/lib/config/runners.js';
import { WORKTREE_ISOLATION_DEFAULTS } from '../../.agents/scripts/lib/config/worktree-isolation.js';
import { DEFAULT_MODEL_CAPACITY } from '../../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';
import { DEFAULT_REGISTRY_PATTERNS } from '../../.agents/scripts/lib/orchestration/ticket-validator-conflicts.js';
import { CODEBASE_SNAPSHOT_TIERS } from '../../.agents/scripts/lib/codebase-snapshot.js';
import { WATCH_DEFAULTS } from '../../.agents/scripts/pr-watch-with-update.js';

/** Prefixes intentionally absent from runtime *_DEFAULTS (agent/workflow-read). */
const AGENT_READ_ONLY_PREFIXES = Object.freeze([
  'project.docsContextFiles',
  'project.baseBranch',
  'planning.riskHeuristics',
  'planning.codebaseSnapshot',
  'planning.failOn',
  'planning.requireExplicitCrossStoryDeps',
  'planning.navigation',
  'planning.largeFanOutThreshold',
  'planning.crossCuttingRegistries',
  'github.owner',
  'github.repo',
  'github.projectNumber',
  'github.projectOwner',
  'github.operatorHandle',
  'github.defaultTimeoutMs',
  'delivery.docsFreshness',
  'delivery.ci.watch',
  'delivery.mergeWatch',
  'delivery.feedbackLoop',
  'delivery.quality.gates.lint',
  'delivery.quality.gates.mutation',
  'delivery.quality.gates.lighthouse',
  'delivery.quality.gates.bundle-size',
  'delivery.quality.gates.duplication',
  'delivery.quality.gateScoping',
  'delivery.quality.autoRefresh',
  'delivery.quality.navigability',
  'delivery.quality.requireBaselines',
  'delivery.quality.formatAutofix',
  'delivery.codeReview.providers',
  'delivery.refactorStage',
  'qa.',
]);

function isAgentReadOnly(dottedPath) {
  return AGENT_READ_ONLY_PREFIXES.some(
    (prefix) => dottedPath === prefix || dottedPath.startsWith(`${prefix}`),
  );
}

describe('full-agentrc-runtime-parity', () => {
  const ref = getAgentrcDefaults({ bustCache: true });

  it('project.paths matches PATHS_DEFAULTS', () => {
    assert.deepEqual(ref.project.paths, { ...PATHS_DEFAULTS });
  });

  it('project.commands matches COMMANDS_DEFAULTS', () => {
    assert.deepEqual(ref.project.commands, { ...COMMANDS_DEFAULTS });
  });

  it('planning.context matches LIMITS_DEFAULTS.planningContext', () => {
    assert.deepEqual(ref.planning.context, {
      ...LIMITS_DEFAULTS.planningContext,
    });
  });

  it('omits planning.modelCapacity (framework constant DEFAULT_MODEL_CAPACITY)', () => {
    assert.equal(ref.planning.modelCapacity, undefined);
    assert.equal(DEFAULT_MODEL_CAPACITY.softSessionTokens, 30000);
    assert.equal(DEFAULT_MODEL_CAPACITY.hardSessionTokens, 75000);
    assert.equal(DEFAULT_MODEL_CAPACITY.mergeCandidateMaxSessionTokens, 1500);
  });

  it('planning.crossCuttingRegistries matches DEFAULT_REGISTRY_PATTERNS', () => {
    assert.deepEqual(ref.planning.crossCuttingRegistries, [
      ...DEFAULT_REGISTRY_PATTERNS,
    ]);
  });

  it('planning.codebaseSnapshot.tier is a known CODEBASE_SNAPSHOT_TIERS value', () => {
    assert.ok(
      CODEBASE_SNAPSHOT_TIERS.includes(ref.planning.codebaseSnapshot.tier),
    );
  });

  it('omits delivery.maxTokenBudget (retired envelope)', () => {
    assert.equal(ref.delivery.maxTokenBudget, undefined);
    assert.equal('maxTokenBudget' in LIMITS_DEFAULTS, false);
  });

  it('delivery execution/lease/signals match LIMITS_DEFAULTS', () => {
    assert.equal(
      ref.delivery.execution.timeoutMs,
      LIMITS_DEFAULTS.executionTimeoutMs,
    );
    assert.equal(ref.delivery.lease.ttlMs, LIMITS_DEFAULTS.leaseTtlMs);
    assert.deepEqual(ref.delivery.signals, { ...LIMITS_DEFAULTS.signals });
  });

  it('delivery.ci.autoMerge matches CI_DELIVERY_DEFAULTS', () => {
    assert.equal(ref.delivery.ci.autoMerge, CI_DELIVERY_DEFAULTS.autoMerge);
  });

  it('delivery.ci.watch matches WATCH_DEFAULTS (poll/maxPolls/maxResumes)', () => {
    assert.equal(
      ref.delivery.ci.watch.pollIntervalMs,
      WATCH_DEFAULTS.pollIntervalMs,
    );
    assert.equal(ref.delivery.ci.watch.maxPolls, WATCH_DEFAULTS.maxPolls);
    assert.equal(ref.delivery.ci.watch.maxResumes, WATCH_DEFAULTS.maxResumes);
  });

  it('delivery.worktreeIsolation matches WORKTREE_ISOLATION_DEFAULTS', () => {
    const wi = ref.delivery.worktreeIsolation;
    assert.equal(wi.enabled, WORKTREE_ISOLATION_DEFAULTS.enabled);
    assert.equal(wi.root, WORKTREE_ISOLATION_DEFAULTS.root);
    assert.equal(
      wi.nodeModulesStrategy,
      WORKTREE_ISOLATION_DEFAULTS.nodeModulesStrategy,
    );
    assert.equal(wi.primeFromPath, WORKTREE_ISOLATION_DEFAULTS.primeFromPath);
    assert.equal(
      wi.allowSymlinkOnWindows,
      WORKTREE_ISOLATION_DEFAULTS.allowSymlinkOnWindows,
    );
    assert.equal(wi.reapOnSuccess, WORKTREE_ISOLATION_DEFAULTS.reapOnSuccess);
    assert.deepEqual(wi.bootstrapFiles, [
      ...WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles,
    ]);
    assert.equal('reapOnCancel' in wi, false);
  });

  it('delivery.deliverRunner / codeReview match getRunners defaults', () => {
    const runners = getRunners({});
    assert.deepEqual(ref.delivery.deliverRunner, runners.deliverRunner);
    assert.equal(
      ref.delivery.codeReview.maxFixAttempts,
      DEFAULT_CODE_REVIEW.maxFixAttempts,
    );
    assert.equal(
      ref.delivery.codeReview.maxFixScopeFiles,
      DEFAULT_CODE_REVIEW.maxFixScopeFiles,
    );
    assert.equal(
      ref.delivery.codeReview.autoFixSeverity,
      DEFAULT_CODE_REVIEW.autoFixSeverity,
    );
  });

  it('delivery.routing matches DELIVERY_ROUTING_DEFAULTS', () => {
    assert.deepEqual(ref.delivery.routing, { ...DELIVERY_ROUTING_DEFAULTS });
  });

  it('delivery.acceptanceEval matches ACCEPTANCE_EVAL_DEFAULTS', () => {
    assert.deepEqual(ref.delivery.acceptanceEval, {
      ...ACCEPTANCE_EVAL_DEFAULTS,
    });
  });

  it('github.branchProtection.requiredChecks matches DEFAULT_REQUIRED_CHECKS', () => {
    assert.deepEqual(
      ref.github.branchProtection.requiredChecks,
      DEFAULT_REQUIRED_CHECKS.map((c) => ({
        name: c.name,
        cmd: [...c.cmd],
      })),
    );
    assert.equal(ref.github.branchProtection.enforce, BRANCH_PROTECTION_DEFAULTS.enforce);
    assert.ok(
      !ref.github.branchProtection.requiredChecks.some(
        (c) => c.name === 'format:check',
      ),
    );
  });

  it('github.mergeMethods / notifications match defaults', () => {
    assert.deepEqual(ref.github.mergeMethods, { ...MERGE_METHODS_DEFAULTS });
    assert.deepEqual(ref.github.notifications, {
      mentionOperator: NOTIFICATIONS_DEFAULTS.mentionOperator,
      commentEvents: [...NOTIFICATIONS_DEFAULTS.commentEvents],
      webhookEvents: [...NOTIFICATIONS_DEFAULTS.webhookEvents],
    });
  });

  it('quality gate floors / codingGuardrails / baselineEpsilon match accessors', () => {
    assert.deepEqual(
      ref.delivery.quality.gates.crap.floors,
      CRAP_GATE_DEFAULTS.floors,
    );
    assert.deepEqual(
      ref.delivery.quality.gates.coverage.floors,
      COVERAGE_GATE_DEFAULTS.floors,
    );
    assert.deepEqual(
      ref.delivery.quality.gates.maintainability.floors,
      MAINTAINABILITY_GATE_DEFAULTS.floors,
    );
    assert.deepEqual(
      ref.delivery.quality.gates.maintainability.targetDirs,
      [...MAINTAINABILITY_GATE_DEFAULTS.targetDirs],
    );
    assert.deepEqual(ref.delivery.quality.codingGuardrails, {
      ...CODING_GUARDRAILS_DEFAULTS,
    });
    assert.deepEqual(ref.delivery.quality.baselineEpsilon, {
      ...BASELINE_EPSILON_DEFAULTS,
    });
  });

  it('rejects retired dead keys', () => {
    for (const dead of [
      'delivery.lifecycle',
      'delivery.retro',
      'delivery.failOnConcurrencyHazards',
      'delivery.signals.hotspot',
      'delivery.ci.skipForStoryPushes',
      'delivery.ci.earlyPr',
      'delivery.ci.requireChecks',
      'delivery.maxTokenBudget',
      'delivery.preflight',
      'delivery.epicAudit',
      'delivery.deliverRunner.progressReportIntervalSec',
      'delivery.worktreeIsolation.reapOnCancel',
      'planning.taskSizing',
    ]) {
      assert.equal(
        lookupPath(ref, dead).present,
        false,
        `retired key ${dead} must not appear in agentrc-reference.json`,
      );
    }
  });

  it('documents AGENT_READ_ONLY_PREFIXES so inventory keys are intentional', () => {
    assert.ok(AGENT_READ_ONLY_PREFIXES.length > 5);
    assert.ok(isAgentReadOnly('qa.featureRoot'));
  });
});
