/**
 * OrchestrationContext family — shared DI bag for the epic runner and the
 * split planning flow.
 *
 * The base class freezes the shared surface (`epicId`, `provider`, `config`,
 * `logger`, `notifier`, `cwd`) so collaborators cannot reach through a ctx and
 * mutate each other's view of the run. Subclasses extend with role-specific
 * knobs:
 *
 *   - `EpicRunnerContext` adds the wave-loop fields required by `runEpic`
 *     and its submodules (`dispatch`, `concurrencyCap`, `storyRetryCount`,
 *     `blockerTimeoutHours`, plus the optional `worktreeResolver`,
 *     `fetchImpl`, `runSkill` injection points). `dispatch` is invoked once
 *     per wave with the `StoryLauncher.planWave` output; the `/epic-deliver`
 *     skill's host-driven wave loop provides the production adapter that
 *     issues parallel Agent-tool calls for the wave.
 *   - `PlanRunnerContext` adds the planning `phase` plus the host-LLM
 *     `plannerClient` adapter threaded through `epic-plan-spec` and
 *     `epic-plan-decompose`.
 *
 * `validate()` is called in the most-derived constructor (via the
 * `new.target` guard in the base) so a partially-built subclass instance
 * never leaks. The instance is then frozen to make the DI surface immutable.
 */

import { resolveConcurrency } from './concurrency.js';

export class OrchestrationContext {
  constructor(opts = {}) {
    this.epicId = opts.epicId;
    this.provider = opts.provider;
    this.config = opts.config;
    this.logger = opts.logger ?? console;
    this.notifier = opts.notifier ?? null;
    this.cwd = opts.cwd ?? null;
    this.concurrency = opts.concurrency ?? resolveConcurrency(opts.config);
    if (new.target === OrchestrationContext) {
      this.validate();
      Object.freeze(this);
    }
  }

  validate() {
    if (!Number.isInteger(this.epicId)) {
      throw new TypeError('OrchestrationContext requires an integer epicId');
    }
    if (!this.provider) {
      throw new TypeError('OrchestrationContext requires a provider');
    }
    if (!this.config) {
      throw new TypeError('OrchestrationContext requires config');
    }
  }
}

export class EpicRunnerContext extends OrchestrationContext {
  constructor(opts = {}) {
    super(opts);
    const runnerCfg = opts.config?.runners?.deliverRunner ?? {};
    this.dispatch = opts.dispatch ?? opts.spawn ?? null;
    this.concurrencyCap =
      opts.concurrencyCap ?? runnerCfg.concurrencyCap ?? null;
    this.storyRetryCount =
      opts.storyRetryCount ?? runnerCfg.storyRetryCount ?? 0;
    this.blockerTimeoutHours =
      opts.blockerTimeoutHours ?? runnerCfg.blockerTimeoutHours ?? 0;
    this.worktreeResolver = opts.worktreeResolver ?? null;
    this.fetchImpl = opts.fetchImpl ?? null;
    this.runSkill = opts.runSkill ?? null;
    this.errorJournal = opts.errorJournal ?? null;
    this.gitAdapter = opts.gitAdapter ?? null;
    this.commitAssertion = opts.commitAssertion ?? null;
    this.autoVersionBump = Boolean(opts.autoVersionBump);
    if (new.target === EpicRunnerContext) {
      this.validate();
      Object.freeze(this);
    }
  }

  validate() {
    super.validate();
    if (!this.config?.runners?.deliverRunner?.enabled) {
      throw new Error(
        'orchestration.runners.deliverRunner.enabled is false — refusing to run.',
      );
    }
    if (typeof this.dispatch !== 'function') {
      throw new TypeError(
        'EpicRunnerContext requires a dispatch adapter (the /epic-deliver skill provides this in production).',
      );
    }
    if (!Number.isInteger(this.concurrencyCap) || this.concurrencyCap < 1) {
      throw new RangeError(
        'EpicRunnerContext requires a positive integer concurrencyCap',
      );
    }
  }
}

export class PlanRunnerContext extends OrchestrationContext {
  constructor(opts = {}) {
    super(opts);
    this.phase = opts.phase ?? null;
    this.plannerClient = opts.plannerClient ?? null;
    if (new.target === PlanRunnerContext) {
      this.validate();
      Object.freeze(this);
    }
  }
}
