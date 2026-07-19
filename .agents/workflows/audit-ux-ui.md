---
description: Audit UX/UI consistency and design system adherence
---

# UX/UI & Design System Audit

## Applicability

**Web targets only.** Registered with `target: "web"` in
[`audit-rules.json`](../schemas/audit-rules.json): the selector skips this lens
on a project with no rendered frontend. See the `target` key's schema
description for how applicability is probed from the consumer's checkout.

## Role

Lead Product Designer & Frontend Architect

## Context & Objective

Evaluate the frontend implementation for UI consistency, UX best practices, and
adherence to the project's design system. Ensure the application feels premium
and cohesive.

## Scope (Story / plan-run mode)

When this lens is invoked from `/deliver` close lenses (or a plan-run audit), the
following block is populated with the Story (or plan-run) change-set file list.
Otherwise — for any manual `/audit-<dimension>` invocation — the block
renders the literal substitution token and you MUST treat it as **no
scope filter — run the lens codebase-wide** exactly as you would have
before this section existed.

```text
{{changedFiles}}
```

- If the block above contains a newline-delimited list of file paths,
  restrict your analysis to those files (and their direct dependencies
  when the lens explicitly calls for cross-file reasoning).
- If the block above renders as the literal string `{{changedFiles}}`
  (i.e. no substitution was supplied), ignore this section entirely and
  proceed with the full codebase-wide scan defined in the remaining
  steps.

## Step 0: Discover the design-system SSOT (run first)

**You cannot audit "adherence to the design system" until you have located the
design system.** There is no universal baseline — a hardcoded `#3b82f6` is a
defect only when the project defines that colour as a token. Before any
detection, locate the consumer's design-system sources of truth and read what
they define:

- **Design tokens / theme:** a `tailwind.config.{js,ts}`, CSS custom properties
  (`:root { --color-*, --space-* }`), a `theme/`, `tokens/`, or `design-system/`
  directory, or a `styled-system` / CSS-in-JS theme object.
- **Component library:** the shared component directory (`components/ui/**`,
  a published design-system package) that raw elements are expected to defer to.
- **Documented conventions:** `docs/style-guide.md` (and `docs/web-routes.md`
  when routing copy is in scope) — the human-authored rules the mechanical
  detectors below cannot infer.

Record the token names, the component roster, and the style-guide rules. Every
finding downstream is measured against *this discovered baseline*, not a generic
ideal. If **no** design-system SSOT exists, say so and downgrade findings to
"no baseline defined — recommend establishing tokens/components first".

## Step 1: Mechanical detector battery, then LLM triage

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Run the **mechanical detectors first** (cheap, deterministic greps that surface
candidates), then apply **LLM triage** to each candidate against the Step 0
baseline — a mechanical hit is a *candidate*, not automatically a finding.

- **Hardcoded Values:** grep for raw `#hex` / `rgb()` colour literals and raw
  `px` font-size / spacing literals **outside** the token/theme files. Each hit
  is a candidate bypass of a defined token.
- **Component Re-implementation:** census raw HTML elements (`<button>`,
  `<input>`, `<select>`, `<a>` styled as a button) versus the design-system
  component that should replace them; a high raw-vs-component ratio is the
  signal.
- **Inline-style census:** count inline `style=` / `style={{…}}` usages that
  encode spacing, colour, or typography a token should own.
- **Interactive States:** scan for `:hover` (or `hover:` utilities) without a
  matching `:focus-visible` / `focus-visible:` — a hover state with no keyboard
  focus state is a candidate accessibility-of-interaction gap.
- **Typography:** flag font families / weights used outside the type scale.

> **Detector output is candidates.** Triage each with the discovered baseline
> before promoting it to a finding — a `px` value inside a token definition file,
> or a raw `<button>` inside the design-system's own `Button` implementation, is
> expected, not a defect.

## Step 2: UX Best Practices

1. **Information Hierarchy:** Is the most important action/information
   prominent?
2. **Error States:** Are form errors clear and helpful, or generic and
   frustrating?
3. **Loading States:** Are there skeletons or spinners for async operations?
4. **Responsiveness:** Check layouts at mobile, tablet, and desktop breakpoints.
5. **Accessibility (UX-focused):** Focus on tab order, touch-target sizes, and
   whether interaction colours come from a sanctioned token. **WCAG conformance
   is out of scope here** — semantic structure, ARIA correctness,
   keyboard/focus operability, form labelling, media alternatives, and the WCAG
   contrast-ratio verdict are owned by [`/audit-accessibility`](audit-accessibility.md).
   This lens keeps token/component design-system adherence; defer every WCAG
   success-criterion judgement to the accessibility lens so the two never
   double-report.

## Step 3: Output Requirements

Generate and save a highly structured Markdown audit report to
`{{auditOutputDir}}/audit-ux-ui-results.md`, using the exact template below.

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md).

```markdown
# UX/UI & Design System Audit report

## Executive Summary

[Overview of design system health (Score 1-10) and adherence to
tokens/components.]

## Detailed Findings

[For every inconsistency or UX improvement identified, use the following strict
structure. Lead each title with the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [e.g., Visual Consistency | UX Best Practices | Accessibility]
- **Impact:** [Critical | High | Medium | Low]
- **Location:** `path/to/primary-file.ext:line`
- **Current State:** [What is currently implemented and why it is sub-optimal]
- **Recommendation & Rationale:** [The specific UI/UX change and how it improves
  premium feel or usability]
- **Acceptance signal:** [the command or observable that proves this finding is remediated — e.g. the token now applied in the rendered component, or a re-run of this lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this UI change independently]`

## Micro-animation Opportunities

- [Suggest 2-3 places where subtle transitions could enhance the "premium"
  feel.]
```

## Constraint

This is a **read-only** audit. Provide the critique and implementation
suggestions, but do not modify styles or components.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does.
