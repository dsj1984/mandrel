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
into a flat `.claude/commands/` tree by `npm run sync:commands` (kept
current at install time and on every `mandrel sync`/`update`) so it shows
up as a bare `/<name>` slash command (e.g. `/deliver`). The projection
writes only `.claude/commands/<name>.md` — there is no plugin manifest and no
marketplace listing. The commands load in every Claude Code environment.

Loop units are the one namespaced exception: files under
`.agents/workflows/loops/<name>.md` project to
`.claude/commands/loops/<name>.md` and are invoked as the namespaced
`/loops:<name>` command. On hosts that flatten subdirectory commands the
same unit surfaces under the flat fallback `/loops-<name>`. They are
listed separately in the **Loops namespace** section below.

This index is regenerated from each workflow’s front-matter `description:`
by `node .agents/scripts/generate-workflows-doc.js`; `npm run docs:check`
fails when it drifts from the on-disk workflow set. To change a command’s
description, edit the workflow file’s front-matter and regenerate.

## Commands (25)

| Command | Description |
| --- | --- |
| `/audit-accessibility` | Audit WCAG accessibility conformance (static-first) with an optional runtime verification pass, and produce a structured findings report |
| `/audit-architecture` | Audit architectural boundaries, module coupling, and layering violations; emit a structured findings report keyed to High/Medium/Low severity. |
| `/audit-clean-code` | Audit code smells, dead code, complexity hotspots, and maintainability-index outliers; emit a structured findings report. |
| `/audit-data-model` | Audit the persistence layer as a first-class artifact — model↔migration↔seed drift, constraint completeness, migration hygiene, type fidelity, and access-pattern fit; gated by a persistence-layer applicability probe so DB-less repos skip cleanly. |
| `/audit-dependencies` | Audit `package.json` for unused, outdated, and major-version-stale dependencies; surface Node-engine drift and propose upgrade batches. |
| `/audit-devops` | Audit CI/CD workflows, container images, infrastructure-as-code, and deployment pipelines; surface failure modes and hardening gaps. |
| `/audit-documentation` | Audit the repository's main documentation for staleness, semantic drift, and completeness; emit a structured High/Medium/Low findings report. |
| `/audit-navigability` | Audit the whole route tree against the consumer's nav-registry SSOT — every route has a persona nav door and no nav href is dead. A deliberately-global lens (Epic #4131, F2/F3) exempt from the cross-epic-leak guard and routed onto route-adding change sets. |
| `/audit-performance` | Audit performance by measuring first — profile hot paths, I/O, memory, and payload against the repo's own numbers — and audit interleaving/partial-failure correctness (TOCTOU, unawaited promises, non-atomic writes) as a first-class dimension. |
| `/audit-privacy` | Audit logs, telemetry, and persistence paths for PII leakage and retention violations; surface secrets exposure and consent gaps. |
| `/audit-quality` | Audit test coverage gaps, flaky tests, missing assertions, and test-pyramid balance; recommend a remediation batch. |
| `/audit-security` | Audit dependency CVEs, input-validation gaps, secrets handling, and auth boundaries; emit a structured High/Medium/Low findings report. |
| `/audit-seo` | Audit SEO fundamentals and Generative Engine Optimization signals (meta, structured data, crawlability); only relevant for web targets. |
| `/audit-sre` | "Audit production-readiness for a release candidate: SLOs, observability, runbooks, error budgets, and rollback paths." |
| `/audit-to-stories` | Convert findings produced by the audit-\* workflows into actionable GitHub Stories. Reads temp/audits/audit-\*-results.md, groups findings cross-audit, deduplicates against existing Issues by fingerprint, and either chains into /plan --seed-file or opens standalone Stories. |
| `/audit-ux-ui` | Audit UX/UI consistency and design system adherence |
| `/deliver` | Unified delivery entry point. Takes a list of Story ids, resolves their dependency graph from live state, and delivers each via the single deliver-story engine — story-<id> → PR → main. |
| `/deliver-light` | Single-session delivery for genuinely small work. Judges a prompt's predicted footprint, authors a receipt Story, then lands it through the same single-story-init / single-story-close engine — every close gate unchanged. |
| `/git-cleanup` | Tidy the local checkout in four phases: fast-forward `main`, prune stale remote-tracking refs, sweep merged branches (squash-aware), and triage `git stash` entries — each step gated by operator confirmation. |
| `/git-deliver` | Single ad-hoc delivery command for working-tree changes. Detects the git setup and escalates to the right terminal step — commit only, commit + push, or commit + push + open a PR with native auto-merge — picking the default from observable state and letting flags pin any level explicitly. Replaces the retired git-commit-all, git-push, and git-pr-all trio. |
| `/mandrel-update` | npm-era upgrade wraparound for a Mandrel consumer. Runs `npx mandrel update` (resolve newest published version → install → re-materialize `.agents/` → migrate → doctor → surface changelog) as the single mechanical step, then walks the operator through the judgment wraparound the CLI deliberately leaves unowned: reconcile `.agentrc.json`, install the Epic #1386 quality-gate surface, refresh the harness permission allowlist, reconcile the consumer's `AGENTS.md` / runbooks against the surfaced changelog, and stage + commit the staged lockfile bump. |
| `/plan` | Unified planning entry point. Interrogate → author → persist. Emits one Story by default; splits into N>1 only under the default-single split policy. |
| `/qa-assist` | Human-led QA assist loop — set up, then ride a rolling multi-observation intake session. The operator reports observations in any order; the agent enriches each (repro + root-cause file:line + coverage verdict for bugs; analysis + options + recommendation for enhancements), asks clarifying questions only when ambiguous, and appends a redacted ledger item — recording, never planning — to a persistent, resumable session under temp/qa/. Only when the operator says they are done does it review the full ledger and hand off to /plan. |
| `/qa-explore` | Agent-led exploratory-QA loop — the agent Plans a surface with an explicit static-vs-drive method choice, drives it (browser MCP or static), and captures ledger items read-only, then Triages — a bounded per-surface session, HITL-gated at every phase transition, routed through the shared dedup/coverage/classification/missing-test/redaction/session core under temp/qa/ |
| `/qa-run` | Drive Gherkin scenarios through a real browser as an agent-driven QA sweep |

## Loops namespace (0)

Loop units project to `.claude/commands/loops/<name>.md` and are invoked
as `/loops:<name>` (flat fallback `/loops-<name>` on hosts that flatten
subdirectory commands).

> No loop units are shipped yet.
