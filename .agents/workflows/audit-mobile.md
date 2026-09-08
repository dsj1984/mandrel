---
description: Audit mobile and tablet UX — layout and viewport correctness, touch ergonomics, responsive assets, and whether anything actually verifies them at a small viewport (static-first, with an optional runtime viewport pass)
---

# Mobile & Tablet UX Audit

You are a Senior Mobile Web Engineer holding the frontend to its **small-screen
and touch contract**: does every surface lay out, scroll, and answer a finger on
a phone and a tablet — and does anything in the suite actually verify that it
does? Default to **static** detection over source; escalate to a **runtime**
viewport pass only when a live target is configured. The shared lens machinery —
read-only constraint, scope interpretation, report envelope + finding-block
skeleton, severity scale, self-cross-check, and execution strategy — lives in
[`helpers/audit-lens-core.md`](helpers/audit-lens-core.md). Write the report to
`{{auditOutputDir}}/audit-mobile-results.md`. Dimension values:
`Layout & Viewport | Touch Ergonomics | Responsive Assets | Mobile Verification`.
Extra finding field: **Evidence:** (`measured | static` + the observable;
single-run runtime numbers are tagged `provisional`).
The report adds a **Runtime Viewport Pass** section.

> **An emulated viewport is not a device.** Viewport emulation resizes and
> re-flows the page; it does not reproduce a real device's browser engine,
> input latency, font rendering, or OS chrome. Report what the emulator
> observed, never "verified on iPhone".

## Applicability

**Web targets only.** Registered with `target: "web"` in
[`audit-rules.json`](../schemas/audit-rules.json): the selector skips this lens
on a project with no rendered frontend, since there is no layout to re-flow and
no control to touch. See the `target` key's schema description for how
applicability is probed from the consumer's checkout.

## Boundaries with the neighbouring lenses

Four lenses border this one. Report a finding **here** only when it is a
small-screen or touch defect; defer the rest so the suite never double-reports:

- [`/audit-accessibility`](audit-accessibility.md) owns every **WCAG
  success-criterion verdict**, including `2.5.8 Target Size (Minimum)`. This
  lens may **measure** a control's rendered size as ergonomic evidence, but the
  conformance verdict on an undersized target belongs there.
- [`/audit-ux-ui`](audit-ux-ui.md) owns **design-system adherence** — whether a
  value came from a sanctioned token and whether a raw element should have
  deferred to a design-system component. This lens asks only whether the result
  works at a small viewport, whatever its provenance.
- [`/audit-performance`](audit-performance.md) owns **Core Web Vitals, bundle
  weight, and network cost**, mobile ones included. An oversized hero image is
  reported here only as a missing `srcset`/`sizes` **contract**, never as a
  payload-weight verdict.
- [`/audit-quality`](audit-quality.md) owns the **generic** test verdicts —
  pyramid balance, flake, and coverage gaps. This lens owns exactly one test
  question: is any of it exercised at a non-desktop viewport, and does that
  exercise assert something mobile-specific (Step 2).

## Scope

Interpret this lens's change-set fence per the core's Scope interpretation:

```text
{{changedFiles}}
```

## Execution strategy

Run this lens as a single `subagent_type: auditor` dispatch returning the report
path + Executive Summary; sequential inline execution is the fallback (see the
core's Execution strategy).

## Step 0: Discover the responsive baseline (run first)

**You cannot audit responsiveness against a generic ideal — a 640px fixed width
is a defect only relative to the breakpoints the project actually claims to
support.** Before any detection, locate this lens's own sources of truth (they
are *not* ux-ui's design system, though they often live beside it) and record
what they declare:

- **Breakpoint scale:** the `screens` map in `tailwind.config.{js,ts}`, CSS
  custom media / container queries, a `breakpoints` token file, or a
  CSS-in-JS theme's media helpers. Census the `@media` / `container` queries
  actually used in the stylesheets and note the narrowest one — that is the
  smallest width the project has any evidence of supporting.
- **Viewport contract:** the `<meta name="viewport">` tag (or the framework
  `viewport` export) and whether it sets `width=device-width` and leaves user
  scaling enabled.
- **Declared device matrix:** any non-desktop viewport already configured in the
  consumer's test tooling — Playwright `projects[]` using `devices[...]` or an
  explicit `viewport`, a Cypress `viewportWidth`/`viewportHeight`, a
  visual-regression viewport list. This is the project's own statement of which
  form factors it holds itself to.
- **Runtime target (optional):** the `qa.environments` map (see
  [*Runtime viewport pass*](#step-3-runtime-viewport-pass-optional-corroboration))
  and the navigability route SSOT.

Record the breakpoints, the viewport contract, and the device matrix. Every
finding downstream is measured against *this discovered baseline*. If the
project declares **no** breakpoint scale and no device matrix, say so and
downgrade findings to "no responsive baseline declared — recommend establishing
a breakpoint scale and a phone/tablet test viewport first" rather than scoring
the tree against an invented one.

## Step 1: Static detection, then triage

Run the **mechanical detectors first** (cheap, deterministic greps over the
in-scope styles and components), then apply **LLM triage** to each candidate
against the Step 0 baseline — a mechanical hit is a *candidate*, not
automatically a finding.

### Layout & Viewport

- **Viewport meta:** absent `<meta name="viewport">`, a missing
  `width=device-width`, or `user-scalable=no` / `maximum-scale=1` pinning the
  page against pinch-zoom.
- **Fixed dimensions:** `width`/`min-width`/`height` px literals wider than the
  narrowest declared breakpoint, outside token and container-query files — the
  classic source of a page that cannot shrink.
- **Viewport-height units:** `100vh` (or `vh` arithmetic) with no `dvh`/`svh`
  fallback, which cuts content off under a mobile browser's collapsing toolbar.
- **Horizontal overflow:** unconstrained wide content — tables, `<pre>` blocks,
  code fences, flex rows with no `min-width: 0`, absolutely-positioned elements
  extending past the viewport — and any `overflow-x: visible` on a container
  holding them. A page whose body scrolls sideways on a phone is a defect
  regardless of its cause.
- **Safe-area insets:** `position: fixed`/`sticky` elements pinned to a screen
  edge (bottom bars, floating actions, drawers, modals) with no
  `env(safe-area-inset-*)` allowance, so a notch or home indicator overlaps
  them.

### Touch Ergonomics

- **Hover-only interaction:** a `:hover`/`hover:` state that reveals content or
  is the only affordance for an action, with no touch-reachable equivalent
  (a click/tap handler, a focus state, or an always-visible control). On a
  touch device that interaction does not exist.
- **Control size and spacing:** interactive controls whose rendered box is
  visibly under ~44×44 CSS px, or adjacent tap targets with no separating
  spacing. Report the **measurement** as ergonomic evidence and leave the
  WCAG `2.5.8` verdict to the accessibility lens.
- **Input ergonomics:** form inputs with a font-size under 16px (iOS Safari
  zooms the whole page on focus), a missing or wrong `inputmode`/`type` for the
  expected keyboard (numeric, email, tel), and `autocomplete` omitted on
  identity or address fields where a small-screen user most needs it.
- **Gesture conflicts:** custom swipe/drag handlers that call
  `preventDefault()` on `touchstart`/`touchmove` across a scrollable region, or
  scroll containers nested inside a horizontal pager, which strand the user's
  scroll.

### Responsive Assets

- **Images:** `<img>` with no `srcset`/`sizes` (or a framework image component
  bypassed for a raw tag) where the same file serves every width; a missing
  intrinsic `width`/`height` or `aspect-ratio`, which shifts the layout as
  images land.
- **Media and embeds:** `<video>`, `<iframe>`, and map/chart embeds with fixed
  pixel dimensions or no responsive container.
- **Typography and spacing:** a type or spacing scale with no small-viewport
  step, so a desktop-tuned heading dominates a phone screen.

> **Detector output is candidates.** Triage each against the Step 0 baseline
> before promoting it to a finding — a fixed width inside a design-system
> primitive that its container query already re-flows, a `100vh` on a
> deliberately desktop-only admin surface, or a raw `<img>` for a fixed-size
> icon, is expected, not a defect.

## Step 2: Mobile verification coverage & effectiveness

A responsive surface with nothing holding it responsive regresses on the next
change. This lens owns that one test question, in two parts — report them as
separate findings, because the fixes differ:

1. **Coverage — is anything exercised at a non-desktop viewport?** Reconcile the
   Step 0 device matrix against the suites that exist: an e2e config with only a
   desktop project, a visual-regression suite with a single wide snapshot width,
   or Gherkin features with no phone/tablet variant all mean the responsive
   behaviour is unverified. Name the specific surfaces in scope that no
   non-desktop run touches.
2. **Effectiveness — does that exercise assert anything mobile-specific?** A
   suite that merely replays its desktop assertions at 390px wide proves the
   page renders, not that it works. Look for assertions that could only pass on
   a small viewport: the drawer or hamburger nav opening in place of the desktop
   bar, the absence of horizontal document scroll, a bottom bar clearing the
   safe area, an orientation change, a swipe or long-press gesture, a
   viewport-conditional element being hidden or shown. A mobile project whose
   assertions are viewport-agnostic is a **false-confidence** finding: it is
   reported even though the suite is green, and it is usually more valuable than
   a missing-coverage finding, because the project believes it is covered.

Keep the generic test verdicts out of this step — pyramid balance, flake, and
overall coverage gaps belong to [`/audit-quality`](audit-quality.md). Where a
fix is a new test, name the viewport and the assertion it should make, not just
"add mobile tests".

## Step 3: Runtime viewport pass (optional corroboration)

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
3. **Drive two form factors per route.** Emulate a **phone** and a **tablet**
   viewport — `mcp__chrome-devtools__emulate` for a device profile, or
   `resize_page` for an explicit width/height — then, per route and viewport:
   take a screenshot, and evaluate the two observables static analysis cannot
   resolve — whether `document.scrollingElement.scrollWidth` exceeds the
   viewport width (horizontal overflow), and the rendered box of the
   interactive controls Step 1 flagged as candidates. Reload after switching
   form factor so load-time device gates re-run.
4. **Median-of-3 or provisional.** Any runtime measurement is subject to
   run-to-run variance: capture a **median-of-3** (three runs per route, report
   the median) before treating a number as authoritative. A single-run value is
   reported **provisional** and never drives a Critical/High verdict on its own.
5. **Leave the viewport as you found it.** Reset the emulation before finishing
   so a following lens or QA run does not inherit a phone viewport.

Corroborate static findings against the runtime observations (a statically
flagged fixed width confirmed by a real horizontal overflow graduates from
provisional to confirmed), and surface runtime-only defects the static pass
could not see — an element clipped only once the toolbar collapses, a drawer
that opens off-screen.

## Report additions

Beyond the shared skeleton, the Executive Summary states the runtime mode's
status (ran against `<env>` / skipped — no target configured) and names the
narrowest breakpoint the project declares, so a reader can tell what "mobile"
meant for this run. The report ends with a **Runtime Viewport Pass** section:
per-route, per-form-factor observations when the runtime mode ran, or
"*Runtime corroboration unavailable — no `qa.environments` target configured.*"
Drop every claimed finding that names no concrete element, style rule, or test
file.
