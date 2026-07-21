---
description: Audit CI/CD workflows, container images, infrastructure-as-code, and deployment pipelines; surface failure modes and hardening gaps.
---

# DevOps Infrastructure Audit

You are a Principal DevOps Engineer & Infrastructure Architect auditing this
repo's DevOps infrastructure, DX tooling, and CI/CD pipelines for
inefficiencies, security risks, and modernization opportunities. The shared lens
machinery — read-only constraint, scope interpretation, report envelope +
finding-block skeleton, severity scale, self-cross-check, and execution
strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-devops-results.md`. The report adds a **Proposed
Implementation Roadmap** section (a logical, phased plan).

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

## Step 1: Detection Battery (Read-Only, Tool-First)

Do **not** audit CI/CD from memory. Run the deterministic battery below first
and let its output ground every finding. Each tool is **presence-gated**: when
the binary is absent, record the gap as a Low-severity `Standardization`
finding (recommend adopting the scanner) and continue — a missing scanner
degrades the audit gracefully, it never aborts it.

1. **Workflow static analysis (`actionlint`).** When `.github/workflows/`
   contains any `*.yml` / `*.yaml`, run:

   ```bash
   command -v actionlint >/dev/null 2>&1 && actionlint -color=never || \
     echo "actionlint: not installed — recommend adding it (Standardization gap)"
   ```

   Every diagnostic `actionlint` emits is a finding (shell-quoting bugs,
   invalid `runs-on`, undefined `needs`, mis-scoped `${{ }}` expressions).

2. **Workflow security posture (`zizmor`).** Over the same
   `.github/workflows/` set, run:

   ```bash
   command -v zizmor >/dev/null 2>&1 && zizmor --no-progress .github/workflows/ || \
     echo "zizmor: not installed — recommend adding it (Security & Compliance gap)"
   ```

   Treat each `zizmor` finding (unpinned action refs, `pull_request_target`
   misuse, over-broad `GITHUB_TOKEN` permissions, template-injection sinks) as
   a Security & Compliance finding at the severity `zizmor` assigns.

3. **Container linting (`hadolint`), presence-gated on Dockerfiles.** Only when
   the change set (or repo) contains a `Dockerfile*`:

   ```bash
   command -v hadolint >/dev/null 2>&1 && hadolint <Dockerfile paths> || \
     echo "hadolint: not installed — recommend adding it (Security & Compliance gap)"
   ```

4. **Pipeline reliability history (`gh run list`).** Cite real durations and
   failure rates rather than guessing which steps are slow or flaky:

   ```bash
   gh run list --limit 50 --json conclusion,durationMs,workflowName,createdAt 2>/dev/null || \
     echo "gh run history unavailable — Performance/Reliability findings degrade to config-only reasoning"
   ```

   Compute the failure rate (`failure` + `cancelled` / total) and the p50/p95
   duration per workflow; a workflow whose recent failure rate is non-trivial
   or whose p95 duration is an outlier is a Reliability or Performance finding
   with the observed number cited in **Current State**.

Then read the surfaces the battery flags plus the standing config set:
CI/CD pipelines (`.github/workflows/`, `.gitlab-ci.yml`, `azure-pipelines.yml`),
dependency/script manifests (`package.json`, `pnpm-workspace.yaml`), lint/format
configs (`.eslintrc*`, `.prettierrc*`, `biome.json`, `tsconfig.json`), and git
hooks / commit standards (`.husky/`, `commitlint.config.js`).

## Step 2: Analysis Dimensions

Evaluate the battery output and gathered context against the following
dimensions. The three **presence-gated sub-steps** (Dockerfile, IaC, Release
pipeline) run only when their surface is present in the change set or repo —
when absent, state "not present in scope" and skip.

1. **Redundancy & Duplication:** Overlapping tools or conflicting rules (e.g.,
   Prettier vs. ESLint formatting, duplicated scripts in `package.json` and CI).
2. **Performance Gaps:** Bottlenecks in CI/CD, slow caching strategies, or
   unoptimized hooks (e.g., missing `lint-staged`) — cite the `gh run list`
   durations from Step 1.
3. **Security & Compliance:** Missing secret scanning, loose permissions (e.g.,
   `GITHUB_TOKEN` scopes), outdated or vulnerable dependency resolution
   strategies — grounded in the `zizmor` output.
4. **Standardization & Modernization:** Opportunities to consolidate tooling
   (e.g., migrating to unified tools like Biome) or extract inline
   configurations into dedicated dotfiles; include any absent-scanner gaps
   surfaced in Step 1.
5. **Reliability & Resilience:** Fragile pipeline steps, missing error handling,
   silent failures, or lack of retries for network-dependent tasks — cite the
   `gh run list` failure rates from Step 1.

### Sub-step A — Dockerfile hardening (gated: `Dockerfile*` present)

Audit each Dockerfile for the standard hardening set: a pinned, digest-or-tag
base image (never `:latest`), a non-root `USER`, multi-stage builds that keep
build tooling out of the runtime image, no secrets baked into layers
(`ARG`/`ENV` for credentials), a `HEALTHCHECK`, and `.dockerignore` coverage.
Ground every finding in the `hadolint` output from Step 1.

### Sub-step B — Infrastructure-as-Code (gated: `*.tf` / `infra/**` / k8s manifests present)

Audit IaC for hardcoded secrets and account IDs, over-permissive IAM / security
groups (`0.0.0.0/0` ingress, wildcard actions), unpinned module/provider
versions, missing remote state locking, and resources provisioned without
encryption-at-rest. Recommend `tflint` / `checkov` / `tfsec` where the scanner
is absent.

### Sub-step C — Release & deployment pipeline (gated: release/deploy workflow present)

Audit the release path for an unpinned or mutable deployment action, missing
environment protection rules / required reviewers on the production
environment, absent rollback or canary strategy, and publish steps that run
without provenance / SLSA attestation. Cite the `gh run list` history for the
release workflow's reliability.
