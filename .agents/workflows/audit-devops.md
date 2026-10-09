---
description: Audit CI/CD workflows, container images, infrastructure-as-code, and deployment pipelines; surface failure modes and hardening gaps.
---

# DevOps Infrastructure Audit

You are a Principal DevOps Engineer & Infrastructure Architect auditing this
repo's DevOps infrastructure, DX tooling, and CI/CD pipelines for
inefficiencies, security risks, and modernization opportunities. The shared lens machinery lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-devops-results.md`. The report adds a **Proposed
Implementation Roadmap** section (a logical, phased plan).

## Scope

Per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as one `subagent_type: auditor` dispatch per the core's
Execution strategy.

## Step 1: Detection Battery (Read-Only, Tool-First)

Do **not** audit CI/CD from memory. Run the deterministic battery below first
and let its output ground every finding. Detect the CI systems and language
ecosystems first per the core's
[Ecosystem detection](helpers/audit-lens-core.md#ecosystem-detection) and run
only the rungs for what is detected. Each tool is **presence-gated**: when the
binary for a **detected** surface is absent, record the gap as a Low-severity
`Standardization` finding (recommend adopting the scanner) and continue — a
missing scanner degrades the audit gracefully, it never aborts it. A tool for
an **undetected** surface is inapplicable and never a finding — `actionlint`,
`zizmor` and `gh run list` on a repo with no `.github/workflows/` are skipped,
not reported missing.

1. **Workflow static analysis (`actionlint`, GitHub Actions only).** When
   `.github/workflows/` contains any `*.yml` / `*.yaml`, run:

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

5. **Google Cloud Build (gated: `cloudbuild*.yaml` present).** Read each
   definition for unpinned builder images (`gcr.io/cloud-builders/*` without a
   digest/tag), secrets passed as plain `env` instead of `secretEnv` /
   `availableSecrets`, an over-broad build service account, and missing
   `timeout`. Then pull run history the same way step 4 does:

   ```bash
   gcloud builds list --limit 50 --format=json 2>/dev/null || \
     echo "gcloud build history unavailable — Cloud Build findings degrade to config-only reasoning"
   ```

   Compute failure rate (`FAILURE` + `TIMEOUT` + `CANCELLED` / total) and
   p50/p95 duration (`finishTime − startTime`) per trigger.

6. **GitLab CI (gated: `.gitlab-ci.yml` present).** Validate the definition
   and read it for unpinned `image:` tags, `variables:` carrying secrets,
   missing `rules:` / `interruptible:`, and absent `cache:` keys:

   ```bash
   glab ci lint 2>/dev/null || echo "glab: not installed — recommend adding it (Standardization gap)"
   glab ci list --per-page 50 -F json 2>/dev/null || \
     echo "glab pipeline history unavailable — GitLab findings degrade to config-only reasoning"
   ```

   Compute failure rate and p50/p95 duration per pipeline as in step 4.
   Azure Pipelines (`azure-pipelines.yml`) is read config-only, with
   `az pipelines runs list` as its history source when the CLI is present.

7. **Python toolchain (gated: Python manifests present).** Read the build and
   lint configuration the Python manifests declare — `pyproject.toml`
   (`[build-system]`, `[tool.ruff]`, `[tool.mypy]`, `[tool.pytest.ini_options]`),
   `.pre-commit-config.yaml`, a lockfile (`uv.lock`, `poetry.lock`,
   `requirements*.txt` with hashes) — and check that CI runs the linters and
   type-checker the config declares. Validate with
   `pre-commit validate-config` and `ruff check --statistics` where present.

Then read the surfaces the battery flags plus the standing config set:
CI/CD pipelines (`.github/workflows/`, `cloudbuild*.yaml`, `.gitlab-ci.yml`,
`azure-pipelines.yml`), dependency/script manifests (`package.json`,
`pnpm-workspace.yaml`, `pyproject.toml`, `requirements*.txt`), lint/format
configs (`.eslintrc*`, `.prettierrc*`, `biome.json`, `tsconfig.json`,
`ruff.toml`, `.pre-commit-config.yaml`), and git hooks / commit standards
(`.husky/`, `commitlint.config.js`).

## Step 2: Analysis Dimensions

Evaluate the battery output and gathered context against the following
dimensions. The three **presence-gated sub-steps** (Dockerfile, IaC, Release
pipeline) run only when their surface is present in the change set or repo —
when absent, state "not present in scope" and skip.

1. **Redundancy & Duplication:** Overlapping tools or conflicting rules (e.g.,
   Prettier vs. ESLint formatting, duplicated scripts in `package.json` and CI).
2. **Performance Gaps:** Bottlenecks in CI/CD, slow caching strategies, or
   unoptimized hooks (e.g., missing `lint-staged`) — cite the run-history
   durations from Step 1 (`gh run list`, `gcloud builds list`, `glab ci list`).
3. **Security & Compliance:** Missing secret scanning, loose permissions (e.g.,
   `GITHUB_TOKEN` scopes), outdated or vulnerable dependency resolution
   strategies — grounded in the `zizmor` output.
4. **Standardization & Modernization:** Opportunities to consolidate tooling
   (e.g., migrating to unified tools like Biome) or extract inline
   configurations into dedicated dotfiles; include any absent-scanner gaps
   surfaced in Step 1.
5. **Reliability & Resilience:** Fragile pipeline steps, missing error handling,
   silent failures, or lack of retries for network-dependent tasks — cite the
   run-history failure rates from Step 1 for every detected CI system.

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
