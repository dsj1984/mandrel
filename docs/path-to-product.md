# Mandrel Product Readiness — Future Work

Last triaged: 2026-05-30 (against `.agents/VERSION` 1.40.0).

Scope: this document is the **standing backlog** of product-readiness gaps that
Mandrel would need to close *if and when it is productized* (sold or distributed
to external customers). It is the residue of an 18-finding readiness audit; the
items that had real internal value today were filed as epics and removed from
this doc.

## Operating assumption

Mandrel is currently an **internal, single-operator, Claude-Code-first /
GitHub-first** framework that is dogfooded. Everything below is **deferred until
a "productize" decision** — none of it blocks internal use. Each item is
grouped under the candidate epic that would carry it.

## Already filed (do not re-scope here)

A 2026-05-30 triage carved the immediately-actionable, internally-valuable work
into four epics. The slices noted as "filed" below live there:

| Epic | Covers | Filed from findings |
|------|--------|---------------------|
| [#3386](https://github.com/dsj1984/mandrel/issues/3386) — truth & correctness | license → MIT, Node floor, dangling CHANGELOG ref | 4, 8, 18 (ref) |
| [#3387](https://github.com/dsj1984/mandrel/issues/3387) — 3-tier doc cutover | scrub stale "Task" concepts | 7 |
| [#3388](https://github.com/dsj1984/mandrel/issues/3388) — config integrity | `.agentrc.local.json` layer, token-budget honesty | 6 (core) |
| [#3389](https://github.com/dsj1984/mandrel/issues/3389) — dev-hygiene | Windows CI smoke, SHA-pin Actions | 9 (Windows), 14 (SHA-pin) |

Findings 4, 7, 8 are fully resolved by the above and are **not** repeated below.
Findings 6, 9, 14, 18 were partially filed; only their deferred remainders
appear here.

---

## The gating decision

> **Productize or stay internal?** This one call gates ~60% of the work below.
> If Mandrel stays internal, none of these epics should be filed. They are
> recorded here so the analysis is not lost, not because they are scheduled.

---

## Candidate epic E-A — Runtime & ticketing portability

**Findings:** 1, 2.

### Finding 1 — The product is Claude Code-first, not runtime-neutral

Evidence:

- `.agents/SDLC.md` states the framework is "Claude Code-first" and runs Story
  sub-agents inside the operator's Claude session.
- `docs/architecture.md` states the dispatch manifest is the cross-runtime
  contract, but also that the manifest `executor` is fixed to `"claude-code"`
  (per the Epic #2646 adapter-removal ADR).
- `.agents/scripts/lib/orchestration/manifest-builder.js` hardcodes
  `executor: 'claude-code'`.
- Bootstrap wires `.claude/settings.json`, `.claude/commands`, and `CLAUDE.md`
  through `.agents/scripts/lib/bootstrap/project-bootstrap.js`.

These choices are **intentional**, not accidental. The gap is only a gap under
productization: buyers on Cursor, Codex, Copilot Workspace, OpenHands, etc.
would have no stable adapter contract.

Remediation direction:

- Decide positioning: "Mandrel for Claude Code" vs "Mandrel across runtimes".
- If runtime-neutral, introduce an execution-provider contract with conformance
  tests, stable dispatch I/O, capability discovery, and ≥1 non-Claude impl.
- If Claude-only, make that explicit in messaging, pricing, docs, support
  boundaries, and compatibility promises.

### Finding 2 — Ticketing and state are GitHub-locked

Evidence:

- `.agents/scripts/lib/provider-factory.js` registers only `github:
  GitHubProvider`, with a comment that a `config.provider` discriminator lands
  "when additional providers land".
- `.agents/README.md` describes GitHub Issues, Labels, Projects V2, Sub-Issues,
  PRs, and `gh` auth as the operating substrate.
- `.agents/starter-agentrc.json` requires a `github` block.
- Bootstrap preflight requires `gh` unless `--skip-github` is set.

Remediation direction:

- Make GitHub-only an explicit product tier/scope, or ship ≥1 more provider.
- Define a provider conformance suite (tickets, hierarchy, comments,
  dependencies, PR lifecycle, auth, rate-limit behavior, idempotency).
- Separate "required issue-tracker state" from GitHub-specific affordances
  (Projects V2 columns, Sub-Issues).

---

## Candidate epic E-B — Distribution & release productization

**Findings:** 3, 18 (remainder).

### Finding 3 — Distribution is not productized

Evidence:

- Root `package.json` has no `bin`, `files`, `publishConfig`, or `workspaces`,
  and empty `description`/`keywords`/`author`. (Intentional: it is the framework
  repo, distributed via the `dist` submodule branch, not a published package.)
- `create-mandrel/package.json` is version `0.0.0` and is not a root workspace.
- `create-mandrel/index.js` hardcodes `https://github.com/dsj1984/mandrel.git`.
- `.github/workflows/ci.yml` "publishes" only by copying `.agents/` to `dist`;
  it does not publish npm packages.

Remediation direction:

- Choose a productized channel: npm package(s), signed release archives,
  Homebrew/winget, or a hosted CLI updater.
- Bring `create-mandrel` into the release/versioning model (non-zero version).
- Add root package metadata + documented install/update/uninstall flows.
- Provide release integrity: checksums, provenance/SLSA, signed tags, a
  compatibility matrix.

### Finding 18 (remainder) — Release process is not ready for paid support

Filed slice: the dangling `docs/upgrade-guide-3-tier.md` reference → #3386.

Deferred remainder:

- `release-please` manages the root package and `.agents/VERSION`; `dist` sync
  copies `.agents/` after main merge; major bumps are intentionally capped
  (`always-bump-minor`).
- Paid products additionally need: a formal version/support policy, deprecation
  policy, rollback guidance, cross-version config-compatibility tests, automated
  migration checks for breaking changes, and operator-facing release notes
  (beyond commit-derived changelog entries).

---

## Candidate epic E-C — Deterministic QA harness

**Finding:** 5.

Today `run-qa-harness.md` is by design a **prose** workflow: the host LLM drives
a `chrome-devtools` MCP surface; deterministic Node helpers under
`.agents/scripts/lib/qa/` do only contract resolution, scenario selection, and
console filtering; there is no headless fallback; and it never files tickets
autonomously (it drafts follow-ups for operator sign-off). All intentional, and
adequate for internal guided QA.

Productization would require a deterministic runner:

- Standard artifacts: JSON/JUnit, screenshots, traces, console/network logs,
  redacted evidence bundles, stable exit codes.
- CI mode, retry policy, quarantine/flake tracking, browser/runtime
  compatibility docs.
- Agent-assisted triage can remain optional on top.

(Large enough it could be its own product line; keep as one epic, decompose
later.)

---

## Candidate epic E-D — Enterprise / commercial readiness

**Findings:** 10, 11, 12, 13, 14 (remainder), 15.

### Finding 10 — Installation mutates customer repos aggressively

Evidence: bootstrap adds deps + scripts to the customer `package.json`, appends
to `prepare` with `&&`, writes `.claude/settings.json`, `.gitignore`,
`CLAUDE.md`, command-sync hooks, quality gates, and GitHub-side
labels/project-fields/branch-protection, and can run a package install. A
`--dry-run` already exists.

Remediation direction: machine-readable dry-run plan; uninstall/rollback and a
minimal/no-mutation profile; separate IDE wiring vs repo config vs GitHub-admin
vs quality gates into independently approved phases; enterprise docs for
required permissions.

### Finding 11 — Configuration surface is large and hard to productize

Evidence: `.agents/full-agentrc.json` is ~274 lines of low-level knobs; the
`starter-agentrc.json` seed is ~21 lines — a large gap between first-look and
full surface.

Remediation direction: product config profiles (solo/local, team/GitHub,
enterprise, QA-only, audit-only); generated per-stack examples; `mandrel doctor`
/ config-explain commands; versioned config migrations with actionable upgrade
messages.

### Finding 12 — Observability is local and operator-centric

Evidence: runtime signals are append-only local NDJSON under `temp/epic-*`;
summaries post to GitHub comments; notification is GitHub comments plus one
generic webhook URL; no dashboard, metrics backend, trace viewer, or
multi-run analytics.

Remediation direction: a telemetry model with privacy controls + opt-in/out;
OpenTelemetry export or a documented events API; run summaries / trend reports /
failure dashboards; retention, redaction, and support-bundle tooling.

### Finding 13 — Cost controls are not a product-grade FinOps system

Evidence: the instruction layer mandates active token tracking + hard stops, but
the implementation mostly estimates prompt-hydration budget and preflight Claude
quota; `/epic-deliver` runs inside the operator's Claude Max session and quota
exhaustion becomes `agent::blocked`. (Instruction-text honesty about this is
already filed in #3388.)

Remediation direction: provider-level usage accounting; per-run/project/user
budgets enforced by deterministic code; pre-dispatch cost estimates + post-run
actuals; policy controls for model selection, concurrency, retry ceilings.

### Finding 14 (remainder) — Security & compliance story is incomplete

Filed slice: SHA-pinning GitHub Actions → #3389.

Existing positives: CI runs `npm audit` + TruffleHog; `.npmrc` sets
`ignore-scripts=true`.

Deferred remainder (procurement gates): no `SECURITY.md`, vulnerability-
disclosure process, SBOM, dependency-license report, signed releases/provenance,
or enterprise data-handling documentation. Add these plus a hardening guide and
documented data flows / token scopes / retention / redaction.

### Finding 15 — No hosted or multi-user control plane

Evidence: delivery runs locally in one operator's agent session; state lives in
GitHub + local `temp/` ledgers; the framework explicitly ships no MCP server and
no remote-trigger surface (by design).

Remediation direction: decide local-first vs hosted/team-first. If hosted,
define a control plane: runs, agents, credentials, audit logs, queues, policies,
billing, org admin.

---

## Candidate epic E-E — Full platform matrix & product-level e2e

**Findings:** 9 (remainder), 17.

Filed slice: one Windows CI smoke leg → #3389.

### Finding 9 (remainder) — Cross-platform support is under-proven

CI is `ubuntu-latest`/Node 22 only (matrix retired in PR #1348); there is
genuine Windows/worktree path & lock-handling code (e.g.
`node-modules-strategy.js` junction-vs-dir symlinks). Beyond the filed Windows
smoke leg, productization needs a full OS×Node×package-manager matrix and a
published support matrix (OS, shell, Node, git, GitHub CLI, package manager,
agent host), treating unsupported environments as explicit preflight failures.

### Finding 17 — Testing is broad but product confidence is narrow

There are ~700 Node test files (714 `*.test.js`) — a strength — but they are
unit/contract-heavy with sparse e2e, and CI is single-leg. Productization needs:
smoke tests against disposable GitHub repos (credential-gated); golden-path
install/update/uninstall tests; nightly end-to-end dogfood runs with artifacts;
and compatibility tests across npm/pnpm/yarn and Windows/macOS/Linux.

---

## Candidate epic E-F — External positioning, UX & onboarding

**Findings:** 16, 6 (remainder).

### Finding 16 — Product UX and discoverability are developer-internal

Evidence: the README assumes Git submodules, GitHub remotes, `gh`, and slash
commands; `.agents/README.md` is framework-author oriented; docs are scattered;
there are no screenshots, demo videos, tutorials, sample repos, comparison
pages, pricing pages, or a "first successful run" path.

Remediation direction: a product landing README (who it's for, outcomes,
constraints, 15-minute demo path); sample repos + scripted demos; scenario
guides (plan an epic, deliver a story, run QA, recover a blocked run, update
Mandrel); symptom-first troubleshooting. Includes the cheap "declare the scope"
messaging that says Mandrel is Claude-Code-first and GitHub-first by design
(the underlying facts from Findings 1 & 2).

### Finding 6 (remainder) — Product claims vs automation

Filed slice: `.agentrc.local.json` layer + token-budget honesty → #3388.

Deferred remainder: surface `WEBHOOK_SECRET` (outbound webhook signing exists in
`notify.js`) in the main onboarding path, and run a full product-claims-vs-code
inventory, converting high-value guarantees into executable acceptance/contract
tests.

---

## Recommended sequencing (only on a productize decision)

1. **E-F positioning** — cheapest, removes the "promises broad, delivers
   narrow" tension.
2. **E-A portability** — the biggest scope multiplier; decide runtime/ticketing
   neutrality early because it shapes everything else.
3. **E-C QA harness** and **E-B distribution** — parallel product builds.
4. **E-D enterprise** and **E-E platform matrix** — gate on first enterprise
   prospect.
