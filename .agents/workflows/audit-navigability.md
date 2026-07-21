---
description: >-
  Audit the whole route tree against the consumer's nav-registry SSOT —
  every route has a persona nav door and no nav href is dead. A
  deliberately-global lens (Epic #4131, F2/F3) exempt from the
  cross-epic-leak guard and routed onto route-adding change sets.
---

# Navigability Audit

You are an Information-Architecture Reviewer & Frontend Navigation Auditor
evaluating **navigability**: every route a persona is entitled to reach has a
real navigation door, and every nav door points at a route that exists. The two
symmetric failure modes are the **orphaned route** (registered but no
nav-registry entry surfaces it for any persona — only a hardcoded deep-link
reaches it) and the **dead nav href** (a nav entry points at a route that does
not exist). This is **mechanism, not content**: the lens reads the consumer's
configured route tree and nav-registry SSOT and is a **silent no-op when neither
is configured**. The shared lens machinery — read-only constraint, scope
interpretation, report envelope + finding-block skeleton, severity scale,
self-cross-check, and execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-navigability-results.md`. Dimension values:
`Orphaned Route | Dead Nav Href`; extra finding fields **Route / Door:** and
**Persona(s):** (identifiers only — never full route bodies or persona PII).

## Applicability

**Web targets only.** Registered with `target: "web"` in
[`audit-rules.json`](../schemas/audit-rules.json). This is consistent with the
lens's own no-op contract below rather than an additional constraint: the
web-surface probe's first signal _is_ configured `routeGlobs`, so a consumer
that has configured this lens's route-tree SSOT always clears the gate. The
gate only bites where the lens had no route data to read anyway — it converts a
silent no-op run into no run at all.

## Whole-route-tree scope (global lens — leak-guard-exempt)

Unlike the change-set-scoped lenses, this lens **always evaluates the whole
route tree + the whole nav registry**, even when the change that triggered it
touched only one route file. Reachability is a global property: adding one
route can orphan it, but removing or renaming a route elsewhere can also break
a nav href that the change set never touched.

Because of this, the navigability lens is registered in the **global-lens
allowlist** (`GLOBAL_LENS_ALLOWLIST` in
[`lib/audit-suite/selector.js`](../scripts/lib/audit-suite/selector.js)) and is
**exempt from the cross-epic-leak guard** that narrows every other lens's
evidence to the change set's `changedFiles`. The exemption is scoped to this
lens only — the guard is **not** weakened for any other lens, and it never lets
a foreign change set leak into a scoped lens.

```text
{{changedFiles}}
```

- For this lens, **ignore** the `{{changedFiles}}` block above even when it is
  populated: navigability is evaluated codebase-wide regardless. The block is
  rendered only for envelope-shape parity with the scoped lenses.

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

## Configuration

Read the consumer's navigability config (resolved from `.agentrc.json`):

- `planning.navigation.routeGlobs` — globs identifying the route-adding files /
  route tree (e.g. `pages/**`, `app/**/route.ts`). This is the same key the
  plan-persist draft reachability gate
  ([`plan-reachability.js`](../scripts/lib/orchestration/plan-reachability.js))
  reads via `resolveNavConfig`, so the lens and the plan gate enumerate the
  route tree from one SSOT.
- `planning.navigation.navRegistry` — path(s) to the consumer's nav-registry
  SSOT this lens reads.

If **neither** `routeGlobs` nor `navRegistry` is present under
`planning.navigation`, emit a one-line "navigability not configured — skipped"
note and exit without findings. Do **not** invent a route tree or guess a nav
registry.

## Step 1: Enumerate the route tree

Enumerate every route from the files matched by `routeGlobs`. Record each
route's path and the persona(s) entitled to reach it (from route metadata,
guards, or the consumer's documented persona model). Log route **identifiers
only** — never the full route body or any persona PII.

## Step 2: Enumerate the nav registry

Read every nav door from the `navRegistry` SSOT. Record each door's target
path and the persona shell it renders in.

## Step 3: Run the deterministic cross-check

The two invariants are a **set-difference over two identifier lists**, not a
judgement call — so run them mechanically rather than eyeballing the two files.
Serialize the enumerated route tree (Step 1) and nav registry (Step 2) to two
JSON files and run the shipped diff tool:

```bash
node .agents/scripts/nav-registry-diff.js \
  --routes <routes.json> --nav <nav-registry.json> [--refs <inbound-refs.json>] --json
```

It prints, deterministically, the two invariants:

1. **Every route has a persona nav door.** A route no door surfaces for an
   entitled persona is an **orphaned route** (`orphanedRoutes`).
2. **No nav href is dead.** A door whose target resolves to no route is a
   **dead nav href** (`deadHrefs`).

The tool also returns `exemptRoutes` — routes it verified are _not_ genuine
orphans (see Step 3a). **Triage the tool's output**: promote each
`orphanedRoutes` / `deadHrefs` entry to a Detailed Finding, and do not report
anything the tool placed in `exemptRoutes`.

## Step 3a: Orphan-verification exemption taxonomy

A naive route-minus-nav set-difference over-reports. Before an unsurfaced route
is reported as orphaned, it must survive this exemption taxonomy (the diff tool
applies it, and you MUST apply the same reasoning to anything you assess by
hand):

- **Dynamic-segment children of a surfaced parent** — a detail route such as
  `/users/:id` (or `/blog/[slug]`) is reached _through_ its surfaced parent
  list, so it is exempt when its parent path has a nav door. It is **not** exempt
  when the parent itself is unsurfaced.
- **System routes** — `/login`, `/logout`, `/register`, `/auth/callback`,
  `/404`, `/401`, `/403`, `/500`, `/unauthorized`, `/forbidden`, and similar are
  reachable by construction (auth walls, error boundaries), never through a
  persona nav door.
- **Inbound in-app references** — a route linked from within the app (a
  `<Link to="…">`, a programmatic `router.push`, an in-content anchor) is
  reachable even without a top-level nav door. Grep the source for an inbound
  reference before reporting the route as orphaned; feed the referenced paths to
  the tool via `--refs`.

Only a route that clears **all** of these is a genuine orphan worth a finding.
