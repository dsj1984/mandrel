---
description: Audit WCAG accessibility conformance (static-first) with an optional runtime verification pass, and produce a structured findings report
---

# Accessibility (WCAG) Audit

## Applicability

**Web targets only.** Registered with `target: "web"` in
[`audit-rules.json`](../schemas/audit-rules.json): the selector skips this lens
on a project with no rendered frontend, since there are no components, templates,
or routes to hold to WCAG. See the `target` key's schema description for how
applicability is probed from the consumer's checkout.

## Role

Senior Accessibility Engineer. You hold the frontend to **WCAG 2.x
conformance** — semantic structure, ARIA correctness, keyboard operability,
form labelling, media alternatives, and contrast — grounding every finding in a
concrete element and the success criterion it violates. You default to
**static** detection over the source, and escalate to a **runtime** pass only
when a live target is configured.

## Context & Objective

This is a **read-only** audit. Detect WCAG violations statically from the
component/template/route source, optionally corroborate them against a running
build, and emit a structured Markdown report at
`{{auditOutputDir}}/audit-accessibility-results.md`. Do not modify application
code — surfacing the violations (each keyed to a WCAG success criterion) is the
deliverable; fixing them is a separate pass.

> **No conformance certification.** The lens reports findings against WCAG
> success criteria; it does **not** assert a conformance level (A / AA / AAA)
> for the product. "No findings in scope" is not "certified conformant".

## Boundary with `audit-ux-ui`

These two web lenses share a border and must not double-report:

- **`audit-accessibility` (this lens)** owns **WCAG conformance** — the
  standards question: does an assistive-technology user perceive, operate, and
  understand the surface? Semantic HTML, ARIA, keyboard/focus, labelled
  controls, text alternatives, and contrast against the WCAG ratio thresholds.
- **`audit-ux-ui`** owns **design-system adherence** — the consistency
  question: do components and tokens match the project's own design system
  (hardcoded values that bypass a token, raw elements that should defer to a
  design-system component, interaction/loading/error states, premium feel)?

Contrast is the one axis both can touch: **accessibility owns the WCAG ratio
verdict** (4.5:1 body / 3:1 large text / 3:1 non-text), while ux-ui owns whether
the colour came from a sanctioned token. When a contrast defect is in scope for
both, report the WCAG failure here and leave the token-adherence note to ux-ui.

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

## Step 0: Discover the frontend surface and config (run first)

**You cannot audit WCAG conformance until you have located what renders and how
the project is configured.** Before any detection:

- **Renderable surface:** the component directories (`components/**`,
  `app/**`, `pages/**`, `src/**`), templates (`**/*.html`, `**/*.astro`,
  framework SFCs), and any design-system component library raw elements are
  expected to defer to.
- **Static a11y tooling already in the repo:** an `eslint-plugin-jsx-a11y`
  config, an `axe-core` / `@axe-core/*` dependency, or a `pa11y` config. Prefer
  reusing the consumer's configured ruleset over inventing one.
- **Design tokens:** the colour tokens (`tailwind.config.*`, CSS custom
  properties, a theme object) whose literal values you need to compute contrast
  ratios statically.
- **Runtime target (optional):** the `qa.environments` map (see
  [_Runtime verification mode_](#step-2-runtime-verification-mode-optional-corroboration))
  and the navigability route SSOT.

Record what exists. Every finding downstream is measured against _this
discovered surface and config_, not a generic ideal. If **no** frontend surface
exists in scope, say so and emit an empty report rather than inventing findings.

## Step 1: Static WCAG detection, then triage

> Apply [`helpers/parallel-tooling.md`](helpers/parallel-tooling.md) when batching the scan below — independent reads belong in one turn, long shells run via `run_in_background` + `Monitor`.

Run the **mechanical detectors first** (cheap, deterministic greps and the
static a11y linters discovered in Step 0), then apply **LLM triage** to each
candidate — a mechanical hit is a _candidate_, not automatically a finding.
Cover every static WCAG dimension:

- **Semantic structure** (WCAG 1.3.1) — landmark regions (`<main>`, `<nav>`,
  `<header>`), a single `<h1>` and a non-skipping heading order, lists for
  list-shaped content, and `<button>`/`<a>` used for their real role rather
  than a clickable `<div>`/`<span>`.
- **ARIA correctness** (WCAG 4.1.2) — census `role=` / `aria-*` usage: invalid
  roles, `aria-*` attributes unsupported on their element, `aria-labelledby` /
  `aria-describedby` pointing at absent ids, redundant roles on native
  elements, and interactive `role=` on a non-focusable element.
- **Keyboard operability & focus management** (WCAG 2.1.1 / 2.4.3 / 2.4.7) —
  click handlers on non-interactive elements with no keyboard handler or
  `tabindex`, positive `tabindex` values, `:hover`/`hover:` states with no
  matching `:focus-visible`/`focus-visible:`, focus traps, and `outline: none`
  with no replacement focus indicator.
- **Forms & labels** (WCAG 1.3.1 / 3.3.2 / 4.1.2) — inputs with no associated
  `<label for>` / wrapping label / `aria-label`, placeholder-as-label,
  unlabelled control groups (`fieldset`/`legend`), and error text not tied to
  its field.
- **Media alternatives** (WCAG 1.1.1 / 1.2.x) — `<img>` with no `alt`
  (and decorative images missing `alt=""`), `<video>`/`<audio>` with no
  captions/transcript track, `<svg>` conveying meaning with no accessible name,
  and icon-only controls with no accessible name.
- **Contrast where statically derivable** (WCAG 1.4.3 / 1.4.11) — when both the
  foreground and background resolve to concrete token/literal colour values,
  compute the ratio and flag body text below 4.5:1, large text below 3:1, and
  non-text/UI boundaries below 3:1. When either colour cannot be resolved
  statically (runtime theme, image background), mark it **provisional** and
  defer confirmation to Step 2 rather than guessing.
- **Raw-element census** — when the project configures a static ruleset,
  reconcile the raw-element findings above against the design-system components
  that already encode the accessible pattern, so the fix lands in one place.

> **Detector output is candidates.** Triage each against the Step 0 surface and
> the specific WCAG success criterion before promoting it to a finding — a role
> on a design-system primitive that already manages focus, or a token `px` value
> inside a token file, is expected, not a defect.

## Step 2: Runtime verification mode (optional corroboration)

Static detection is the default and always runs. The runtime pass is
**conditional** — it runs only when a live target is configured; its absence
never blocks the static report.

1. **Resolve the target from config — never a hardcoded URL.** Resolve the
   target through the consumer's `qa.environments.<env>.baseUrl` (via
   [`resolveQaEnvironment`](../scripts/lib/qa/resolve-qa-contract.js), the same
   resolver `/qa-run` uses): an `<env>` argument resolves by exact name or
   origin match; with no argument, enumerate `name → baseUrl` and let the
   operator pick. If **no** `qa.environments` target is configured, **skip this
   step** and note in the report that runtime corroboration was unavailable —
   do not invent a URL and do not start an arbitrary dev server.
2. **Sample routes from the navigability SSOT.** Draw the routes to exercise
   from the consumer's route/nav registry (`planning.navigation.navRegistry` /
   `routeGlobs` — the same SSOT [`/audit-navigability`](audit-navigability.md)
   reads), sampling a representative set (key personas' landing routes plus any
   route in the change-set scope) rather than a single hardcoded page.
3. **Run an accessibility engine per sampled route.** Use the
   `mcp__chrome-devtools__lighthouse_audit` tool's **Accessibility category**,
   or run **axe** via the browser tooling, against each sampled `baseUrl`-rooted
   route. Prefer a production-mode build.
4. **Median-of-3 or provisional.** Any runtime score or metric is subject to
   run-to-run variance: capture a **median-of-3** (three runs per route, report
   the median) before treating a number as authoritative. A single-run value is
   reported **provisional** and never drives a Critical/High verdict on its own.

Corroborate static findings against the runtime results (a statically-flagged
contrast defect confirmed by the engine graduates from provisional to
confirmed), and surface runtime-only violations the static pass could not see.

## Step 3: Output Requirements

Generate and save a structured Markdown report to
`{{auditOutputDir}}/audit-accessibility-results.md`, using the exact template
below. The report MUST include all sections, even if empty (write
"_No findings._" rather than omitting a section).

> Grade every finding's severity on the shared
> [`Critical | High | Medium | Low` scale](helpers/audit-severity-scale.md), and
> key every finding to the WCAG success criterion it violates.

```markdown
# Accessibility (WCAG) Audit report

## Executive Summary

[Overview of WCAG conformance health across the scope, the runtime mode's
status (ran against `<env>` / skipped — no target configured), and the
self-cross-check line.]

## Detailed Findings

[For every WCAG violation identified, use the following strict structure. Lead
each title with the primary file the finding lives in:]

### `path/to/primary-file.ext` — [Short title of the issue]

- **Dimension:** [e.g., Semantic Structure | ARIA | Keyboard & Focus | Forms & Labels | Media Alternatives | Contrast]
- **Severity:** [Critical | High | Medium | Low]
- **WCAG:** [success criterion — e.g. `1.1.1 Non-text Content (A)`]
- **Location:** `path/to/primary-file.ext:line`
- **Evidence:** [measured | static] [the observable — a quoted element, the
  computed contrast ratio, the failing axe/Lighthouse audit id + median score.
  Runtime numbers from a single run are tagged `provisional`.]
- **Current State:** [what is implemented and why it fails the criterion]
- **Recommendation & Rationale:** [the specific change — attribute to add,
  element to swap, token to adjust — and the assistive-technology behaviour it
  restores]
- **Acceptance signal:** [the command or observable that proves this finding is
  remediated — e.g. the axe rule now passing on the route, or a re-run of this
  lens]
- **Agent Prompt:**
  `[A copy-pasteable, highly specific prompt to execute this a11y fix independently]`

## Runtime Verification

[Per-route median-of-3 accessibility scores when the runtime mode ran, or
"_Runtime corroboration unavailable — no `qa.environments` target configured._"]
```

## Constraint

This is a **read-only** audit. Provide the critique and implementation
suggestions, but do not modify components, styles, or configuration. The
runtime mode runs **non-mutating** measurements only and starts no arbitrary
dev server.

## Self-cross-check (mandatory — filter false positives before you finalize)

Before you write the report artifact from the previous step, run the shared
adversarial self-cross-check over your Detailed Findings — see
[`helpers/audit-self-check.md`](helpers/audit-self-check.md). It defines the
per-finding evidence bar, the exclusion list, and the final re-open-and-drop
pass whose `kept <k> / dropped <d>` counts you record in the Executive
Summary, so the sequential single-pass path filters unverified findings just as
the orchestrated path's adversarial reviewer does. Drop every claimed
violation that names no concrete element and no specific WCAG success
criterion.
