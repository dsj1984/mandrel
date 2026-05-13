---
name: /wave-execute degenerates under /epic-execute fan-out
description: General-purpose sub-agents reading wave-execute.md misread "the sub-agent" as themselves and skip the fan-out, collapsing a wave to one /story-execute call
type: feedback
originSessionId: e0b9064b-18bb-4584-801c-0243ca3d19f1
---

# /wave-execute degenerates under /epic-execute fan-out

When `/epic-execute` dispatches a wave via the `Agent` tool, the spawned general-purpose sub-agent (the "wave-LLM") reads `.agents/workflows/wave-execute.md` to drive the wave. The skill's per-child prompt contract previously said "Tells **the sub-agent** to invoke `/story-execute <storyId>`" — and a sub-agent reading that text misread "the sub-agent" as itself, skipping the Step 2 fan-out and just running one `/story-execute` directly.

**Why:** Surfaced 2026-05-07. The bug is invisible at single-Story-wave granularity (fan-out of 1 ≈ direct call), and the wave-record envelope still parses, so it slips past the recorder. Manifests as "only one Story per wave executes" under a multi-Story plan.

**How to apply:**

- The skill text was rewritten on 2026-05-07 (commit `88574f9` on main): `"the sub-agent"` is now `"the child"` everywhere it referred to wave-execute's children, plus a "You vs. your children" preamble at the top of Step 2 and a constraint forbidding `/story-execute` self-invocation. `epic-execute.md` Step 2.1 also now requires the wave-dispatch prompt to spell out "your job is to dispatch further Agent tool calls — not to invoke /story-execute itself."
- If you see this regress (a wave only executing the first Story), check that the disambiguation language is still present in [.agents/workflows/wave-execute.md](.agents/workflows/wave-execute.md) Step 2 and Step 5 before chasing runner code.
- The same shape of bug — sub-agent reading skill markdown that calls *its own children* "the sub-agent" — could recur in any future fan-out skill. When writing a new fan-out skill, always say "the child" and add an explicit "you (the parent) vs. the child you are spawning" preamble.
