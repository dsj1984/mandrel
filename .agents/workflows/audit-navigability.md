---
description: >-
  Audit the whole route tree against the consumer's nav-registry SSOT —
  every route has a persona nav door and no nav href is dead. A
  deliberately-global lens (Epic #4131, F2/F3) exempt from the
  cross-epic-leak guard and routed onto route-adding change sets.
---

# Navigability Audit

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

- `delivery.quality.navigability.routeGlobs` — globs identifying the
  route-adding files / route tree (e.g. `pages/**`, `app/**/route.ts`). Drives
  both the route-tree enumeration here and the route-added routing in
  [`epic-audit-prepare.js`](../scripts/epic-audit-prepare.js).
- `delivery.quality.navigability.navRegistry` — path(s) to the consumer's
  nav-registry SSOT this lens reads.

If **neither** `routeGlobs` nor `navRegistry` is present, emit a one-line
"navigability not configured — skipped" note and exit without findings. Do
**not** invent a route tree or guess a nav registry.

## Step 1: Enumerate the route tree

Enumerate every route from the files matched by `routeGlobs`. Record each
route's path and the persona(s) entitled to reach it (from route metadata,
guards, or the consumer's documented persona model). Log route **identifiers
only** — never the full route body or any persona PII.

## Step 2: Enumerate the nav registry

Read every nav door from the `navRegistry` SSOT. Record each door's target
path and the persona shell it renders in.

## Step 3: Cross-check (the two invariants)

1. **Every route has a persona nav door.** For each enumerated route, assert at
   least one nav-registry entry surfaces it for an entitled persona. A route
   with no door for any of its personas is an **orphaned route**.
2. **No nav href is dead.** For each nav door, assert its target resolves to a
   real route in the route tree. A door whose target is absent is a **dead nav
   href**.

## Step 4: Output Requirements

Generate and save a structured Markdown audit report to
`{{auditOutputDir}}/audit-navigability-results.md`, using the template below.

```markdown
# Navigability Audit report

## Executive Summary

[Reachability health (Score 1-10): count of orphaned routes and dead hrefs.]

## Detailed Findings

[For every orphaned route or dead nav href, use the following strict
structure:]

### [Short Title of the Issue]

- **Dimension:** [Orphaned Route | Dead Nav Href]
- **Impact:** [High | Medium | Low]
- **Route / Door:** [the route path or nav-door identifier — identifier only]
- **Persona(s):** [the persona(s) affected]
- **Current State:** [why the route is unreachable or the href is dead]
- **Recommendation & Rationale:** [the nav-registry change that restores
  reachability — add a door for the orphaned route, or fix/remove the dead
  href]
- **Agent Prompt:**
  `[A copy-pasteable, specific prompt to execute the nav-registry fix.]`
```

## Constraint

This is a **read-only** audit. Provide the critique and the nav-registry fixes,
but do not modify the route tree or the nav registry. Log route and door
identifiers only — never full route bodies, source contents, or persona data.
