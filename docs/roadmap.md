# Mandrel Roadmap

> **Forward-looking only.** This file carries what has **not** been built:
> strictly aspirational items and monitors that re-price on ~10x shifts in
> model capability, platforms, or economics. Operational dependency
> trip-wires live in the appendix.
>
> **Shipped work is not tracked here.** Design records are preserved in git
> history at the release tag that carried them, and the anchors in the
> appendix map the in-code citations that still point at them. The v2.0.0
> Story collapse — one ticket type, one delivery engine, one branch model —
> shipped in full; its design record, deletion inventory, accepted
> trade-offs, and staged build checklist live at `docs/roadmap.md` @
> `mandrel-v2.0.0`. How the resulting system works is documented in
> [`architecture.md`](architecture.md) and the workflow prose, not here.
>
> **Last reviewed:** 2026-07-16 against framework version 2.0.0.

## 1. Someday — aspirational & model-shift monitors

Strictly items that are **aspirational** or that **re-price on a ~10x shift**
in model capability, agent platforms, or inference economics. Operational
dependency trip-wires live in the appendix, not here.

1. **Worktree demotion to an implementation option** — re-price when agent
   platforms ship reliable per-task sandboxes
   ([#4385](https://github.com/dsj1984/mandrel/issues/4385) tracked the
   related capability lift). Until then worktree isolation is concurrency
   physics and keeps.
2. **Remaining sequential-only audit lenses** (`audit-dependencies`,
   `audit-devops`, `audit-sre`, `audit-privacy`, `audit-seo`, `audit-ux-ui`,
   `audit-lighthouse`) — re-price on inference economics. Several are
   externally bound or not dimensionally decomposable; sequential may be the
   correct default forever. Any generalization must clear the measured
   **~5× token-multiple / no-precision-loss gate** lens-by-lens (anchor:
   `audit-clean-code`, 2026-06-04 — 23 agents, ~2.47M tokens, 49/51 findings
   kept). Do not batch-convert.
3. **Multi-Story plan-authoring quality spike** — aspirational, and doubly
   rare under the default-single split policy: when `/plan` legitimately
   authors N>1 Stories, a parallel-draft + adversarial-consolidation pass
   could improve seam quality. Hold to the same measured-delta discipline as
   the audit gate.
4. **Dynamic spec / Gherkin mutation engine** — aspirational; static
   placeholder lint (`check-gherkin-placeholders.js`) is the supported
   surface. **Trip-wire (both):** consumer demand on the BDD tier *and* a
   dogfood fixture.
5. **Productize-or-stay-internal** 🚪 — aspirational/external; the one
   product decision gating the entire readiness backlog (runtime/ticketing
   portability, release maturity, deterministic QA runner,
   enterprise/compliance, platform matrix, external positioning). Nothing in
   it blocks internal use; build none of it until the call is made. Full
   analysis preserved at `docs/roadmap.md` @ `mandrel-v1.94.0` (Part 2).
6. **Beyond v2: the harness as validators-only** — the standing 10x
   question. Each model tier absorbs more of the procedural scaffold; the
   durable kernel is what the model cannot self-provide (external state,
   deterministic validation, isolation, gates, HITL risk appetite). At each
   major model shift, re-run the audit: what remaining prose is now a
   retirement candidate?

## Appendix — standing watches & historical anchors

**Operational dependency trip-wires** (not roadmap work — policy notes kept
here so Someday stays aspirational):

- **`typhonjs-escomplex`** 🔭 — the complexity kernel behind the
  CRAP/maintainability gates is pinned at its terminal `0.1.0` (last release
  2018). Deliberately not swapped: stable, pure JS, no reachable CVE; every
  baseline stamps its resolved version, so any swap is its own project with
  a full baseline recut. **Trip-wire:** a CVE against it, or install/parse
  failure under a future Node major. Renovate is pinned off
  (`renovate.json`).
- **`typescript` peer floor `>=5.0.0`** 🔒 — a permissive floor, not a pin;
  raising it is a consumer-visible break. **Watch:** only relevant if the
  maintainability transpiler config ever adopts a TS-6-removed flag.

**Historical anchors.** Doc comments and prose across the tree cite sections
of earlier roadmaps that this file no longer carries. Their content is
preserved in git history at the tags below — resolve a citation by reading
`docs/roadmap.md` at that tag.

| Citation | Cited by | Preserved at |
| --- | --- | --- |
| **§ v2.0.0** / **Stage 3** — the Story collapse | `plan-persist.js`, `run-plan-persist.js`, `story-ops.js`, `split-policy-validator.js`, `ticket-validator-sizing.js` | `mandrel-v2.0.0` |
| **Part 1 — Model-Evolution Audit** (incl. "Also parked") | `git-conventions-reference.md`, `renovate.json` | `mandrel-v1.94.0` |
| **Part 2 — product-readiness backlog** | Someday item 5 above | `mandrel-v1.94.0` |
| **Part 3 — Dynamic-Workflow Orchestration** | `capability.js`, the `audit-*.md` lens workflows | `mandrel-v1.94.0` |

The Part 1 audit's conclusion — **risk routes rigor, never scope** — and its
Keep-invariants survive as live policy in
[`instructions.md`](../.agents/instructions.md) and
[`security-baseline.md`](../.agents/rules/security-baseline.md); its standing
question survives as Someday item 6. The Part 3 per-lens cost/precision gate
survives as Someday item 2. The `typhonjs-escomplex` note Renovate cites as
"Part 1, 'Also parked'" is the trip-wire above.
