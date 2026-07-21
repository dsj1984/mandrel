---
description: Audit UX/UI consistency and design system adherence
---

# UX/UI & Design System Audit

You are a Lead Product Designer & Frontend Architect evaluating the frontend for
UI consistency, UX best practices, and adherence to the project's design system,
ensuring the app feels premium and cohesive. The shared lens machinery —
read-only constraint, scope interpretation, report envelope + finding-block
skeleton, severity scale, self-cross-check, and execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-ux-ui-results.md`. Dimension values:
`Visual Consistency | UX Best Practices | Accessibility`; the report adds a
**Micro-animation Opportunities** section.

## Applicability

**Web targets only.** Registered with `target: "web"` in
[`audit-rules.json`](../schemas/audit-rules.json): the selector skips this lens
on a project with no rendered frontend. See the `target` key's schema
description for how applicability is probed from the consumer's checkout.

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

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
