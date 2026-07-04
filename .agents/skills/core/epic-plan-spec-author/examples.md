# epic-plan-spec-author — examples & extended rationale

Read this file on demand while authoring the Tech Spec. The SKILL.md carries
the operating contract (Policy Capsule, Inputs / Outputs, Procedure, the two
authoritative system prompts, and Constraints); this file carries the worked
Delivery Slicing example and the extended rationale behind the slicing rules.

## Delivery Slicing — extended rationale

The Tech Spec MUST carry a `## Delivery Slicing` section in which the Architect
— who holds the full design — proposes how the Epic's enumerated capabilities
**cluster into N shippable Stories**. This section is the intentional grouping
the Phase 8 consolidation pass
([`epic-plan-consolidate`](../epic-plan-consolidate/SKILL.md)) reconciles the
decomposer's draft against before any GitHub write. Without it, the decompose
phase maps Epic capabilities to Stories ~1:1 and cannot produce a coarser,
holistic plan; with it, the consolidation critic has a well-defined reference
instead of a guess.

**The proposed count is a ceiling, not a target.** Consolidation reconciles
the draft *toward* your grouping, but it treats the count as an upper bound: it
may **merge below** your proposed count when slices form dependent
single-consumer chains, and it **never splits above** it. Over-slicing here
therefore locks in fragmentation only when the extra slices are genuinely
independent — so keep a slice separate only when it earns its own delivery
session.

**Write the Delivery Slicing section before any other section — it is the
primary input to Phase 8 consolidation.** Author it first so the rest of the
spec (Core Components, API Changes, Data Models) hangs off a deliberate
slicing decision rather than being reverse-engineered into one at the end.
Drafting it last is exactly how the model omits it under the weight of the
other sections.

Author the section as a table — one row per proposed slice — naming the
capability cluster each slice would deliver, what ships in it, and whether it
can ship independently. Use **noun phrases** for slice names ("Foundation",
"Transport seam", "Send helper") so they map cleanly onto Feature titles in the
resulting decomposition — never verb phrases ("Add transport") or file names
("`sender.ts`"). Do **not** coarsen the Epic's capability enumeration to produce
the slicing: the granularity lever is *this* grouping recommendation, not a
dumbed-down Epic enumeration.

**What "Independent?" means:** can this slice ship to production and provide
value *without the next slice landing*? A `Yes` slice is releasable on its own;
a `No` slice only becomes valuable once a later slice lands on top of it.

**"Independent? No" is a smell that must be justified.** A dependent,
single-consumer slice (one that only feeds the next slice) folds into its
consumer by default — it is not worth its own delivery session's hydration,
branch, PR, and CI ceremony. Mark a slice `No` only when you can name a
one-line reason to keep it separate anyway: **parallelism** (two `No` slices
that can be delivered concurrently by different sessions), **risk isolation**
(a blast-radius or reviewability reason to land it as its own reviewable PR),
or **delivery-envelope pressure** (folding it in would push the consumer past a
single-session sizing envelope). Absent such a justification, do not author the
slice as its own row — fold it into its consumer and let the merged slice carry
the combined capability.

### Worked example

```text
## Delivery Slicing

Proposed shippable slices (consolidation ceiling for Phase 8):

| Slice          | What ships                                              | Independent? |
| -------------- | ------------------------------------------------------ | ------------ |
| Foundation     | Config schema, types, and the no-op default path       | Yes          |
| Transport seam | The pluggable transport interface + in-memory adapter  | Yes          |
| Send helper    | The send() helper + retries, built on the transport    | No (justified: risk isolation) |

- **Foundation** folds Epic capabilities "config surface" + "type model" — they
  share a reason to exist and ship as one reviewable PR.
- **Transport seam** is the pluggable boundary; it provides value on its own
  (in-memory adapter is usable for tests) so it is independently shippable.
- **Send helper** depends on the transport seam landing first, so it is *not*
  independent. It stays its own slice only because the retry/backoff logic is a
  large, high-blast-radius surface worth isolating in its own reviewable PR
  (risk isolation). Absent that justification it would fold into Transport
  seam — a bare "depends on the previous slice" is not a reason to keep it
  separate.
```

The consolidation pass degrades gracefully when this section is absent (it
falls back to cohesion + single-Story-Feature rules only), so authoring it is
how the Architect steers the decomposition toward fewer, right-sized Stories.
Because the count is a **ceiling**, an over-sliced table is coarsened back
during consolidation — but only where the extra slices are dependent
single-consumer chains, so an unjustified `No` slice is the one you should fold
in yourself rather than leaning on the consolidator to catch.
