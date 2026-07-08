# Spike — Fan-out epic-plan decomposition: measured quality/token delta

> **Status: complete. Recommendation: KEEP SEQUENTIAL (do not adopt fan-out as
> the default decomposition path).** Story #4389 under Epic #4385. This is a
> written recommendation; it changes **no** production planning script and does
> **not** flip the default decomposition path.

## 1. Question

The [roadmap](../roadmap.md) (§ *Beyond audits — fan-out epic-plan
decomposition*) proposes mapping the audit lenses' proven shape — **fan-out →
adversarial cross-check → synthesis** — onto epic-plan decomposition: draft
Stories in parallel sub-agents, then run an adversarial whole-plan
consolidation critic. The roadmap holds the idea to the same discipline as the
per-lens cost gate: **a measured plan-quality delta vs. token multiple before
it becomes a default, with sequential as the capability-degraded fallback.**

This spike supplies that measurement. It answers one question: *on a
representative Epic, does fan-out decomposition buy enough plan quality to
justify its token multiple over today's single-context decomposition?*

## 2. Method

### Representative Epic (fixture with a known answer key)

The test subject is **Epic #4385 itself** — a real, mid-size framework Epic
that decomposed into **6 Stories across 2 waves** (2 independent foundation
Stories unblocking 4 dependent ones). Its shipped `## Delivery Slicing` section
is the **ground-truth answer key**.

Both arms received an identical fixture: Epic #4385's `Context`, `Goal`,
`Non-Goals`, `Scope`, `Acceptance Criteria`, and `Risk & Verification` sections
**with the `## Delivery Slicing` section deliberately removed**, so each arm had
to *derive* the Story backlog rather than transcribe it. The fixture is 4,808
characters. Neither arm saw the answer key.

### Two arms

- **Arm A — single-context (today's shape).** One sub-agent drafted the full
  backlog and self-consolidated (single-consumer merge rule, "one Story = one
  coherent change") in **one context**. This mirrors production, where
  `epic-plan-decompose-author` and `epic-plan-consolidate` run as same-context
  Skill activations inside `/plan`.
- **Arm B — fan-out (the proposal).** **Three drafter sub-agents ran in
  parallel, in isolation** (no drafter could see another's output), each owning
  one capability cluster of the Epic: *contracts/docs*, *guard machinery*,
  *execution wins & spikes*. Their union then went to **one adversarial
  consolidation critic** sub-agent that deduped across cluster seams, applied
  the single-consumer merge rule, and rewired the cross-cluster dependency DAG.

### Token measurement

Token counts are the **actual `subagent_tokens` reported by each spawned
sub-agent** (not the ≈4-char/token estimate). The per-spawn *context tax* — the
always-loaded bundle (`CLAUDE.md` + `AGENTS.md` + `.agentrc.json` +
`instructions.md` + `engineer.md` + the two core rules) every sub-agent re-pays
on spawn — was measured directly at **56,943 chars ≈ 14,236 tokens per spawn**.

## 3. Results

### Token cost (measured)

| Arm | Spawns | Component tokens | Total tokens |
| --- | --- | --- | --- |
| **A — single-context** | 1 | 79,491 | **79,491** |
| **B — fan-out** | 4 | drafters 78,038 + 83,748 + 76,839 = 238,625; critic 65,874 | **304,499** |

**Measured token multiple: 304,499 ÷ 79,491 = ~3.83×.**

Two caveats both push the *real-world* multiple **higher** than 3.83×:

1. **Arm A is charged a context tax it would not pay in production.** Measured
   Arm A is itself a spawned sub-agent, so it paid the ~14.2k context tax once.
   Real sequential decomposition runs *inline* in the already-loaded `/plan`
   session and pays that tax **zero** extra times — so the production baseline
   is cheaper than 79,491, and the true multiple is above 3.83×.
2. **~23% of Arm B's spend is pure re-paid boilerplate.** Fan-out's 4 spawns
   re-paid the context tax 4× (4 × 14,236 ≈ 56,943 tokens ≈ 19% of Arm B's
   total), plus the critic re-reads all three drafts. This overhead scales with
   spawn count, not with plan complexity.

### Wall-clock (measured)

Fan-out delivered **no** wall-clock win. The three drafters ran in parallel
(28–54 s each), but the serial consolidation critic took **179 s** — longer
than Arm A's *entire* run (54 s). For a holistic task the synthesis step
dominates, so fan-out was both more expensive **and** slower end-to-end.

### Plan quality — side-by-side

Ground truth: **6 Stories, 2 waves.** Foundation S1 (codify contracts) folds
the depth-envelope record, the `#2870` supersession, and the
`acceptance-self-eval.md` inline-critic fallback into one coherent change;
foundation S2 inverts the guard; four dependent Stories (audit fan-out,
planning critics, decomposition spike, coordinator spike) each depend on both
foundations.

| Dimension | Arm A — single-context | Arm B — fan-out |
| --- | --- | --- |
| **Story count** | **6 (exact match to ground truth)** | 8 drafted → **7 after consolidation** (residual over-slice) |
| **Over-slicing** | None. Correctly folded the inline-critic fallback + envelope record into the S1 codify Story on the first pass. | The isolated *contracts/docs* drafter split S1 into **3** Stories; the critic recovered 2 but left `self-eval-inline-critic-fallback` as a standalone 3rd foundation Story — a residual over-slice vs. ground truth. |
| **Dependency DAG** | Correct and complete on the first pass (all 4 wave-2 Stories → both foundations), *with explicit reasoning about which merges to reject* (rejected S3+S4 and S5+S6 as two-reason Stories). | **All 8 drafts had `depends_on: [none]`** — isolation made every drafter dependency-blind. The *entire* DAG was reconstructed by the single-context critic. It did so well (finer per-edge reasoning: spikes → guard only, not docs), but the parallel drafting contributed **nothing** to the hardest part of the task. |
| **Cohesion ("one reason to exist")** | Strong — self-consolidation notes lead every merge with its reason. | Mixed — the critic's per-edge dependency reasoning is arguably *finer* than Arm A's blanket edges, but that gain hinges on keeping the over-sliced 7th Story, so it is entangled with a defect. |
| **Holistic view** | Free — one context sees the whole plan and folds correctly at draft time. | Bought at a premium — the holistic view exists **only** in the serial critic; the fan-out layer actively *destroyed* the cross-cluster information (dependencies, single-consumer folds spanning clusters) the task most needs. |

## 4. Interpretation — why decomposition is not audit-shaped

Fan-out cleared the cost/precision gate for the audit lenses because audits are
**dimensionally decomposable**: each lens is genuinely independent and the
adversarial cross-check *tightens* findings (the measured anchor:
`audit-clean-code`, ~4.9×, precision preserved). Decomposition is the
**opposite** — it is a **holistic, tightly-coupled** problem. The Story
boundaries and the dependency DAG are *global* properties: a single-consumer
fold can span two clusters, and a dependency edge is meaningless inside one
cluster's isolation. Partitioning the Epic by cluster forces each drafter to be
blind to exactly the coupling that decomposition *is about*.

The evidence shows this concretely:

- Fan-out **reintroduced** over-slicing (7 vs. 6 Stories) — the very defect the
  roadmap names as "the dominant plan defect." Single-context did **not**
  over-slice.
- Fan-out produced a **dependency-blind** draft product (every edge `[none]`);
  100% of the DAG had to be rebuilt serially in the critic. The parallelism
  bought nothing for the plan's hardest, most valuable structure.
- The one arguable quality *gain* (finer per-edge dependencies) came from the
  **single-context critic**, not from the fan-out — i.e. it is available to a
  sequential second pass without paying for parallel drafting at all.

The roadmap's own prerequisite note anticipated this: *"re-baseline
decomposition quality on the new uniform sizing profile first, since
over-slicing… may disappear without orchestration."* This spike goes one step
further — under the current sizing profile, single-context decomposition
**already** hits ground truth, while fan-out **adds** the over-slice it was
meant to remove.

## 5. Recommendation — KEEP SEQUENTIAL

**Do not adopt fan-out as the default epic-plan decomposition path. Keep the
current single-context decompose-author + consolidate flow.**

Grounding in the measured evidence and the roadmap's governing gate
("generalize to the orchestrated default only when the measured orchestrated
cost is justified by a **precision gain**"):

- **Token multiple ~3.83× (real-world higher), with no precision gain** — in
  fact a slight precision *loss* (7 vs. 6 Stories, a residual seam over-slice).
  Even though 3.83× sits under the roadmap's ~5× No-Go ceiling, the GO
  condition is a *precision gain*, and there is none. Under-5× is necessary,
  not sufficient.
- **No wall-clock win** — fan-out was slower end-to-end (179 s critic vs. 54 s
  total for Arm A).
- **Structural mismatch** — fan-out's partition step destroys the cross-cluster
  coupling information that determines plan quality; the holistic view has to be
  rebuilt serially regardless.

The cheapest available *quality* improvement, if one is wanted, is **not**
fan-out but a **second single-context critic pass** (the source of Arm B's only
real quality edge) — obtainable at ~1× additional cost without any parallel
drafting.

### The sequential path as the capability-degraded fallback

Because fan-out is **not** recommended, the sequential single-context path
remains the **primary** default, not a fallback — there is no capability-gated
degradation to name today.

For completeness against the roadmap's dual-path discipline: **if** a future
re-measurement ever flips this recommendation (e.g. a materially larger or
genuinely dimensionally-separable Epic shape shows a real precision gain within
the ~5× ceiling), then adoption **MUST** retain the single-context path as the
explicit **capability-degraded fallback** — selected automatically on a
non-Claude runtime, with sub-agent nesting disabled, or below the dynamic-
workflow version floor — exactly as every orchestrated audit lens keeps its
capability-gated sequential fallback (`selectAuditStrategy → sequential`). Any
such adoption is a configuration/default change guarded by the same per-lens
cost/precision gate, lens by lens, never a batch cutover.

## 6. Reproduction

- **Fixture:** Epic #4385 body, `Context`/`Goal`/`Non-Goals`/`Scope`/
  `Acceptance`/`Risk` sections, `## Delivery Slicing` removed (answer key).
- **Arm A:** one `general-purpose` sub-agent, draft + self-consolidate in one
  context.
- **Arm B:** three isolated `general-purpose` drafter sub-agents (clusters:
  contracts/docs, guard-machinery, execution-wins) → one consolidation-critic
  `general-purpose` sub-agent over their union.
- **Metric:** actual `subagent_tokens` per spawn; per-spawn context tax
  measured from the always-loaded bundle (56,943 chars ≈ 14,236 tokens).
- **Measured:** Arm A 79,491 tokens; Arm B 304,499 tokens; **multiple ~3.83×**;
  Arm A 6 Stories (matches ground truth), Arm B 7 Stories (residual over-slice).

> This spike is a point-in-time measurement on one representative Epic, held to
> the roadmap's gate. It changes no production default; it records the evidence
> that keeps decomposition sequential until a measured precision gain says
> otherwise.
