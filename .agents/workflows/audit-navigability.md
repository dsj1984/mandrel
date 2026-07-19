---
description: >-
  Audit the whole route tree against the consumer's nav-registry SSOT —
  every route has a persona nav door and no nav href is dead. A
  deliberately-global lens (Epic #4131, F2/F3) exempt from the
  cross-epic-leak guard and routed onto route-adding change sets.
---

# Navigability Audit

## Applicability

**Web targets only.** Registered with `target: "web"` in
[`audit-rules.json`](../schemas/audit-rules.json). This is consistent with the
lens's own no-op contract below rather than an additional constraint: the
web-surface probe's first signal _is_ configured `routeGlobs`, so a consumer
that has configured this lens's route-tree SSOT always clears the gate. The
gate only bites where the lens had no route data to read anyway — it converts a
silent no-op run into no run at all.

## Role

Information-Architecture Reviewer & Frontend Navigation Auditor

## Context & Objective

Evaluate the application's **navigability**: the property that every route a
persona is entitled to reach has a real navigation door (a menu item, link, or
button rendered in that persona's authenticated shell), and that every nav door
points at a route that actually exists. The two failure modes this lens names
are symmetric:

- **Orphaned route** — a route is registered in the route tree but no
  nav-registry entry surfaces it for any persona. The feature ships but is
  unreachable through the product; only a hardcoded deep-link reaches it.
- **Dead nav href** — a nav-registry entry points at a route (or path) that
  does not exist in the route tree. The door is rendered but leads nowhere.

This is **mechanism, not content**: the lens reads the consumer's
configured route tree and nav-registry SSOT (see _Configuration_) and is a
**silent no-op when neither is configured**. Mandrel ships the slot and the
wiring; it never ships a specific consumer's route data or nav registry.

## Whole-route-tree scope (global lens — leak-guard-exempt)

Unlike the change-set-scoped lenses, this lens **always evaluates the whole
route tree + the whole nav registry**, even when the change that triggered it
touched only one route file. Reachability is a global property: adding one
route can orphan it, but removing or renaming a route elsewhere can also break
a nav href that the change set never touched.

Because of this, the navigability lens is registered in the **global-lens
allowlist** (`GLOBAL_LENS_ALLOWLIST` in
[`lib/audit-suite/selector.js`](../scripts/lib/audit-suite/selector.js)) and is
**exempt from the cross-epic-leak guard** (`#3362`) that narrows every other
lens's evidence to the Epic's `changedFiles`. The exemption is scoped to this
lens only — the guard is **not** weakened for any other lens, and the
exemption never lets a foreign Epic's change set leak into a scoped lens.

```text
{{changedFiles}}
```

- For this lens, **ignore** the `{{changedFiles}}` block above even when it is
  populated: navigability is evaluated codebase-wide regardless. The block is
  rendered only for envelope-shape parity with the scoped lenses.

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

## Step 4: Output Requirements

Generate and save a structured Markdown audit report to
`{{auditOutputDir}}/audit-navigability-results.md`, using the template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# Navigability Audit report

## Executive Summary

[Reachability health (Score 1-10): count of orphaned routes and dead hrefs.]

## Detailed Findings

[For every orphaned route or dead nav href, use the following strict structure.
Lead each title with the primary file (route module or nav registry) the
finding lives in:]

### `path/to/nav-registry-or-route.ext` — [Short title of the issue]

- **Dimension:** [Orphaned Route | Dead Nav Href]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/nav-registry-or-route.ext:line`
- **Route / Door:** [the route path or nav-door identifier — identifier only]
- **Persona(s):** [the persona(s) affected]
- **Current State:** [why the route is unreachable or the href is dead]
- **Recommendation & Rationale:** [the nav-registry change that restores
  reachability — add a door for the orphaned route, or fix/remove the dead
  href]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. a re-run of this lens reporting the route reachable]
- **Agent Prompt:**
  `[A copy-pasteable, specific prompt to execute the nav-registry fix.]`
```

## Constraint

This is a **read-only** audit. Provide the critique and the nav-registry fixes,
but do not modify the route tree or the nav registry. Log route and door
identifiers only — never full route bodies, source contents, or persona data.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
