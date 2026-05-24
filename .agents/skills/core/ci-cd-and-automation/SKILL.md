---
name: ci-cd-and-automation
description:
  Automates CI/CD pipeline setup. Use when setting up or modifying build and
  deployment pipelines. Use when you need to automate quality gates, configure
  test runners in CI, or establish deployment strategies.
---

# CI/CD and Automation

## Policy Capsule

- Every PR passes the same quality-gate pipeline before merge: **lint → typecheck → unit tests → build → integration tests → optional E2E → security audit → bundle-size**. Gates are ordered shift-left so cheap checks fail first.
- **No gate may be skipped.** Failing lint means fix lint, not disable the rule. Failing a test means fix the code, not delete or `.skip` the test.
- **Faster is safer.** Prefer many small, frequent releases over big-bang merges; one deploy of three changes is debuggable, one deploy of thirty is not.
- Cache aggressively (npm cache, build cache) and split lint / typecheck / test into parallel jobs to keep PR feedback under ~10 minutes.
- Use GitHub Secrets (or platform equivalent) for every credential — even in CI-only test databases. Never hardcode credentials in workflow YAML.
- Wire preview deployments for every PR so reviewers can exercise the change in a production-like environment before merge.
- Feed CI failure output verbatim back to the agent loop with the specific error and the directive to verify locally before re-pushing.
- Treat the security audit (`npm audit` or equivalent) as gating: critical and high vulnerabilities reachable in production code MUST be remediated before merge.
- Enforce a bundle-size budget in CI; a budget breach blocks the change just like a failing test.

## Overview

Automate quality gates so that no change reaches production without passing
tests, lint, type checking, and build. CI/CD is the enforcement mechanism for
every other skill — it catches what humans and agents miss, and it does so
consistently on every single change.

**Shift Left:** Catch problems as early in the pipeline as possible. A bug
caught in linting costs minutes; the same bug caught in production costs hours.
Move checks upstream — static analysis before tests, tests before staging,
staging before production.

**Faster is Safer:** Smaller batches and more frequent releases reduce risk, not
increase it. A deployment with 3 changes is easier to debug than one with 30.
Frequent releases build confidence in the release process itself.

## When to Use

- Setting up a new project's CI pipeline
- Adding or modifying automated checks
- Configuring deployment pipelines
- When a change should trigger automated verification
- Debugging CI failures

## The Quality Gate Pipeline

Every change goes through these gates before merge:

```text
Pull Request Opened
    │
    ▼
┌─────────────────┐
│   LINT CHECK     │  eslint, prettier
│   ↓ pass         │
│   TYPE CHECK     │  tsc --noEmit
│   ↓ pass         │
│   UNIT TESTS     │  jest/vitest
│   ↓ pass         │
│   BUILD          │  npm run build
│   ↓ pass         │
│   INTEGRATION    │  API/DB tests
│   ↓ pass         │
│   E2E (optional) │  Playwright/Cypress
│   ↓ pass         │
│   SECURITY AUDIT │  npm audit
│   ↓ pass         │
│   BUNDLE SIZE    │  bundlesize check
└─────────────────┘
    │
    ▼
  Ready for review
```

**No gate can be skipped.** If lint fails, fix lint — don't disable the rule. If
a test fails, fix the code — don't skip the test.

**Introducing a new gate that asserts on pre-existing state** (doc-drift,
lint-vocabulary, dependency-cycle, missing-test-coverage) has its own
hazard: the gate lands red because of latent findings nobody authored,
and every downstream PR is blocked until someone hotfixes the integration
branch. Before wiring such a gate into `requiredChecks`, read
[`core/introducing-a-baseline-gate`](../introducing-a-baseline-gate/SKILL.md) —
it covers the two landing shapes (advisory-first or
populate-the-baseline) that keep the gate green at merge.

## CI Configuration (GitHub Actions)

A representative pipeline for a Node project runs lint → type check → unit
tests → build → security audit on every PR and push to `main`. Add
integration jobs that spin up service containers (e.g. Postgres) and an E2E
job that installs Playwright and uploads the report on failure.

> See [`examples.md`](./examples.md) for full GitHub Actions YAML covering:
>
> - Basic CI pipeline (lint, types, tests, build, audit)
> - Integration tests with a Postgres service container + Prisma migrations
> - Playwright E2E with report artifacts
> - Caching and parallelism (split lint/typecheck/test into separate jobs)
>
> Use GitHub Secrets for credentials — even in CI-only test databases — to
> avoid normalizing hardcoded values that could leak into other contexts.

## Feeding CI Failures Back to Agents

The power of CI with AI agents is the feedback loop. When CI fails:

```text
CI fails
    │
    ▼
Copy the failure output
    │
    ▼
Feed it to the agent:
"The CI pipeline failed with this error:
[paste specific error]
Fix the issue and verify locally before pushing again."
    │
    ▼
Agent fixes → pushes → CI runs again
```

**Key patterns:**

```text
Lint failure → Agent runs `npm run lint --fix` and commits
Type error  → Agent reads the error location and fixes the type
Test failure → Agent follows debugging-and-error-recovery skill
Build error → Agent checks config and dependencies
```

## Deployment Strategies

### Preview Deployments

Every PR gets a preview deployment for manual testing — most platforms (Vercel,
Netlify, Cloudflare Pages) ship a one-step action you wire into the PR
workflow. See [`examples.md`](./examples.md) for a representative Vercel
preview-deploy job.

### Feature Flags

Feature flags decouple deployment from release. Deploy incomplete or risky
features behind flags so you can:

- **Ship code without enabling it.** Merge to main early, enable when ready.
- **Roll back without redeploying.** Disable the flag instead of reverting code.
- **Canary new features.** Enable for 1% of users, then 10%, then 100%.
- **Run A/B tests.** Compare behavior with and without the feature.

**Flag lifecycle:** Create → Enable for testing → Canary → Full rollout →
Remove the flag and dead code. Flags that live forever become technical debt —
set a cleanup date when you create them. See [`examples.md`](./examples.md)
for a minimal flag-check pattern.

### Staged Rollouts

```text
PR merged to main
    │
    ▼
  Staging deployment (auto)
    │ Manual verification
    ▼
  Production deployment (manual trigger or auto after staging)
    │
    ▼
  Monitor for errors (15-minute window)
    │
    ├── Errors detected → Rollback
    └── Clean → Done
```

### Rollback Plan

Every deployment should be reversible. Wire a `workflow_dispatch` job that
takes a target version as input and re-deploys it; see
[`examples.md`](./examples.md) for a representative manual-rollback workflow.

## Environment Management

```text
.env.example       → Committed (template for developers)
.env                → NOT committed (local development)
.env.test           → Committed (test environment, no real secrets)
CI secrets          → Stored in GitHub Secrets / vault
Production secrets  → Stored in deployment platform / vault
```

CI should never have production secrets. Use separate secrets for CI testing.

## Automation Beyond CI

### Dependabot / Renovate

Schedule dependency updates so they show up as PRs you can triage in batches
rather than chasing security advisories ad hoc. A minimal `dependabot.yml` is
in [`examples.md`](./examples.md); Renovate's config covers the same shape
with more knobs.

### Build Cop Role

Designate someone responsible for keeping CI green. When the build breaks, the
Build Cop's job is to fix or revert — not the person whose change caused the
break. This prevents broken builds from accumulating while everyone assumes
someone else will fix it.

### PR Checks

- **Required reviews:** At least 1 approval before merge
- **Required status checks:** CI must pass before merge
- **Branch protection:** No force-pushes to main
- **Auto-merge:** If all checks pass and approved, merge automatically

## CI Optimization

When the pipeline exceeds 10 minutes, apply these strategies in order of impact:

```text
Slow CI pipeline?
├── Cache dependencies
│   └── Use actions/cache or setup-node cache option for node_modules
├── Run jobs in parallel
│   └── Split lint, typecheck, test, build into separate parallel jobs
├── Only run what changed
│   └── Use path filters to skip unrelated jobs (e.g., skip e2e for docs-only PRs)
├── Use matrix builds
│   └── Shard test suites across multiple runners
├── Optimize the test suite
│   └── Remove slow tests from the critical path, run them on a schedule instead
└── Use larger runners
    └── GitHub-hosted larger runners or self-hosted for CPU-heavy builds
```

### Example: Caching and Parallelism

Split lint, typecheck, and test into separate jobs that each restore the npm
cache via `actions/setup-node`'s `cache: 'npm'` option. See
[`examples.md`](./examples.md) for a parallel three-job layout.

## Common Rationalizations

| Rationalization                   | Reality                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| "CI is too slow"                  | Optimize the pipeline (see CI Optimization below), don't skip it. A 5-minute pipeline prevents hours of debugging. |
| "This change is trivial, skip CI" | Trivial changes break builds. CI is fast for trivial changes anyway.                                               |
| "The test is flaky, just re-run"  | Flaky tests mask real bugs and waste everyone's time. Fix the flakiness.                                           |
| "We'll add CI later"              | Projects without CI accumulate broken states. Set it up on day one.                                                |
| "Manual testing is enough"        | Manual testing doesn't scale and isn't repeatable. Automate what you can.                                          |

## Red Flags

- No CI pipeline in the project
- CI failures ignored or silenced
- Tests disabled in CI to make the pipeline pass
- Production deploys without staging verification
- No rollback mechanism
- Secrets stored in code or CI config files (not secrets manager)
- Long CI times with no optimization effort

## Verification

After setting up or modifying CI:

- [ ] All quality gates are present (lint, types, tests, build, audit)
- [ ] Pipeline runs on every PR and push to main
- [ ] Failures block merge (branch protection configured)
- [ ] CI results feed back into the development loop
- [ ] Secrets are stored in the secrets manager, not in code
- [ ] Deployment has a rollback mechanism
- [ ] Pipeline runs in under 10 minutes for the test suite
