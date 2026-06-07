<!--
  GENERATED FILE — do not edit by hand.
  Source of truth: `.agents/workflows/*.md` front-matter `description:`.
  Regenerate with: node .agents/scripts/generate-workflows-doc.js
  Drift is gated by `npm run docs:check`.
-->

# Workflow (Slash-Command) Reference Index

This is an **auto-generated reference index** of every slash command shipped
under `.agents/workflows/` (top-level only — `helpers/` are path-included
modules, not runnable commands). The canonical workflow narrative lives in
[`SDLC.md`](SDLC.md) — read that first to understand how the commands
compose. This file is only for "which command does X?" lookups.

Every command file lives at `.agents/workflows/<name>.md` and is projected
into a flat `.claude/commands/` tree by `npm run sync:commands` (the
UserPromptSubmit hook keeps it current) so it shows up as a bare `/<name>`
slash command (e.g. `/epic-deliver`). The projection writes only
`.claude/commands/<name>.md` — there is no plugin manifest and no
marketplace listing. The commands load in every Claude Code environment.

This index is regenerated from each workflow’s front-matter `description:`
by `node .agents/scripts/generate-workflows-doc.js`; `npm run docs:check`
fails when it drifts from the on-disk workflow set. To change a command’s
description, edit the workflow file’s front-matter and regenerate.

## Commands (27)

| Command | Description |
| --- | --- |
| `/agents-update` | npm-era upgrade wraparound for a Mandrel consumer. Runs `mandrel update` (resolve newest non-major version → install → re-materialize `.agents/` → migrate → doctor → surface changelog) as the single mechanical step, then walks the operator through the judgment wraparound the CLI deliberately leaves unowned: reconcile `.agentrc.json`, install the Epic #1386 quality-gate surface, refresh the harness permission allowlist, reconcile the consumer's `AGENTS.md` / runbooks against the surfaced changelog, and stage + commit the staged lockfile bump. |
| `/audit-architecture` | Audit architectural boundaries, module coupling, and layering violations; emit a structured findings report keyed to High/Medium/Low severity. |
| `/audit-clean-code` | Audit code smells, dead code, complexity hotspots, and maintainability-index outliers; emit a structured findings report. |
| `/audit-dependencies` | Audit `package.json` for unused, outdated, and major-version-stale dependencies; surface Node-engine drift and propose upgrade batches. |
| `/audit-devops` | Audit CI/CD workflows, container images, infrastructure-as-code, and deployment pipelines; surface failure modes and hardening gaps. |
| `/audit-lighthouse` | Run a Lighthouse audit (Performance / Accessibility / Best Practices / SEO) and produce a structured findings report |
| `/audit-performance` | Audit hot paths, algorithmic complexity, and I/O bottlenecks in the tooling surface (`epic-close`, dispatcher, gates); propose remediations. |
| `/audit-privacy` | Audit logs, telemetry, and persistence paths for PII leakage and retention violations; surface secrets exposure and consent gaps. |
| `/audit-quality` | Audit test coverage gaps, flaky tests, missing assertions, and test-pyramid balance; recommend a remediation batch. |
| `/audit-security` | Audit dependency CVEs, input-validation gaps, secrets handling, and auth boundaries; emit a structured High/Medium/Low findings report. |
| `/audit-seo` | Audit SEO fundamentals and Generative Engine Optimization signals (meta, structured data, crawlability); only relevant for web targets. |
| `/audit-sre` | "Audit production-readiness for a release candidate: SLOs, observability, runbooks, error budgets, and rollback paths." |
| `/audit-to-stories` | Convert findings produced by the audit-\* workflows into actionable GitHub Stories. Reads temp/audits/audit-\*-results.md, groups findings cross-audit, deduplicates against existing Issues by fingerprint, and either chains into /epic-plan --idea or opens standalone Stories. |
| `/audit-ux-ui` | Audit UX/UI consistency and design system adherence |
| `/epic-deliver` | Drive an Epic from `agent::ready` to a merged pull request against `main`. The ten-phase flow runs the wave loop, close-validation, epic-audit, code-review, retro, finalize, watch-and-iterate, conditional auto-merge, and local branch cleanup. When the run is end-to-end clean (zero manual interventions, zero 🔴/🟠 review findings, compact retro) the PR auto-merges via `gh pr merge --squash --delete-branch`; otherwise the workflow falls back to the operator-merges-button path so a human inspects the surface area. |
| `/epic-plan` | Orchestrates end-to-end Epic planning (PRD, Tech Spec, Acceptance Spec, and Work Breakdown) for a GitHub Epic. |
| `/explain` | Walk the operator through a code change until they genuinely understand it. Targets a PR, a branch, or the working-tree diff, then drives the `core/knowledge-transfer` skill (restate-first, why-ladder, mastery gates, persistent checklist) with an operator-controlled stop at every checkpoint. |
| `/git-cleanup` | Tidy the local checkout in four phases: fast-forward `main`, prune stale remote-tracking refs, sweep merged branches (squash-aware), and triage `git stash` entries — each step gated by operator confirmation. |
| `/git-commit-all` | Stage every untracked and modified file, then create a single conventional-commit on the current branch (no push). |
| `/git-merge-pr` | Analyze, validate, resolve conflicts, and merge a given pull request by number. |
| `/git-pr-all` | Stage all outstanding changes, commit, push to a feature branch, and open a pull request with native auto-merge enabled. |
| `/git-push` | Commit all outstanding changes then push to the remote repository. |
| `/onboard` | Guided first-run onboarding for a freshly installed Mandrel. Detects the consumer stack, offers to scaffold any missing docsContextFiles, runs `mandrel doctor` as a readiness gate, and hands off to a started /epic-plan. The whole path is designed to take about 15 minutes from a clean checkout to a planned Epic. |
| `/qa-explore` | Operator-facing exploratory-QA loop — Plan, read-only Capture, then Triage — that wires the dedup, coverage, classification, missing-test, redaction, and session helpers into a HITL session ledger under temp/qa/ |
| `/qa-run-harness` | Drive Gherkin scenarios through a real browser as an agent-driven QA sweep |
| `/story-deliver` | Deliver one or more standalone Stories end-to-end. Accepts 1+ Story IDs, computes a dependency-aware wave plan via `stories-wave-tick.js`, asks the operator to confirm the plan, then fans out parallel Agent calls per wave — each delegating to `helpers/single-story-deliver`. Stories without an `Epic: #N` reference only; Epic-attached Stories use `/epic-deliver`. |
| `/story-plan` | Author a standalone Story (no parent Epic) from a short prompt. Builds a context envelope, lets the host LLM draft the body, and creates the GitHub Issue with type::story and a persona label — ready to feed into /single-story-deliver. |
