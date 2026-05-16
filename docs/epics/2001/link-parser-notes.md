# Link Parser Investigation (Story #2091 / Task #2098)

Working notes that scope the repair landing in
[Task #2092](https://github.com/dsj1984/mandrel/issues/2092) and the unit
test landing in
[Task #2093](https://github.com/dsj1984/mandrel/issues/2093). A copy is
mirrored to `temp/epic-2001/link-parser-notes.md` (gitignored working
artefact) so the Story decomposition's literal acceptance criterion is
also satisfied.

## Exact File & Function

- **Module:** `.agents/scripts/lib/issue-link-parser.js`
- **Exported function:** `parseLinkedIssues(body)`
- **Line range:** 1–25 (single-function module — the whole file is the
  parser).
- **Caller:** `.agents/scripts/providers/github/mappers.js` line 52
  inside `issueToEpic(issue)`, which mounts the parsed result on
  `epic.linkedIssues`.
- **Consumer:** `closePlanningArtifacts()` in
  `.agents/scripts/epic-deliver-finalize.js` lines 310–350, which reads
  `epic.linkedIssues.prd` / `epic.linkedIssues.techSpec` and short-
  circuits to `status: 'skipped', detail: 'no-link'` when either is
  `null`.

## Current Regex Format

```js
const PRD_RE = /(?:PRD|prd)[:\s]+#(\d+)/;
const TECH_SPEC_RE = /(?:Tech Spec|tech.?spec|technical.?spec)[:\s]+#(\d+)/i;
```

The parser returns `{ prd: number|null, techSpec: number|null }`. There
is **no** `acceptanceSpec` slot in the parser, the
`epic.linkedIssues` typedef, or the `closePlanningArtifacts` consumer
today.

## Planning Artifacts Markdown Currently Emitted

`epic-plan-spec.js` Phase-1 persist (line 243):

```text


## Planning Artifacts
- [ ] PRD: #{prdId}
- [ ] Tech Spec: #{techSpecTicket.id}
```

The `planning-state-manager.js` "heal dangling references" path (line
158) emits the same two-line shape when it discovers existing canonical
artefacts on a previously-planned Epic with an empty body. No code path
emits an Acceptance Spec line today.

## Observed Mismatch vs Today's Markdown

The existing regexes correctly extract `prd` and `techSpec` IDs from
the canonical emitted markdown — verified against a real Epic body
(Epic #1471 = `temp/epic-2001/sample-1471-body.md`), which returns
`{ prd: 1544, techSpec: 1545 }` for the existing parser. So the two
existing slots are not the regression vector under steady-state flow.

The actual gap that prevents `closePlanningArtifacts` from cascading
the new `context::acceptance-spec` ticket Epic #2001 is introducing is:

1. **Missing parser slot.** `parseLinkedIssues` has no `acceptanceSpec`
   field. Every Epic body — including ones that will soon emit
   `- [ ] Acceptance Spec: #N` lines once Epic #2001's wider work lands
   — therefore returns `acceptanceSpec: undefined`, the consumer
   short-circuits with `status: 'skipped', detail: 'no-link'`, and the
   ticket stays open after `/epic-deliver` finalizes.
2. **No JSDoc / typedef coverage.** The function's `@returns` and the
   `PlanCheckpointState` typedef in `planning-state-manager.js` line 20
   only enumerate `prd` and `techSpec`, so callers relying on the type
   contract have no way to know an acceptance-spec slot exists.
3. **Consumer surface.** `closePlanningArtifacts` reads two keys
   explicitly; it must read the third once the parser populates it,
   otherwise the parser repair does nothing observable.

## Required Repair (input to Task #2092)

1. Extend `parseLinkedIssues` to recognise
   `Acceptance Spec` / `acceptance-spec` / `accept.?spec` and populate
   `acceptanceSpec: number | null` on the returned object.
2. Keep the existing `prd` / `techSpec` extraction behaviour unchanged.
3. Update the function JSDoc and the `PlanCheckpointState` /
   `closePlanningArtifacts` typedefs to enumerate the new slot.
4. Teach `closePlanningArtifacts` to iterate the third slot so a
   populated `acceptanceSpec` is actually closed.

## Required Test Coverage (input to Task #2093)

Round-trip a representative Epic body and assert the parser returns
non-null IDs for `prd`, `techSpec`, **and** `acceptanceSpec`. Cover the
four cases the parent Story names:

- prd only
- prd + techSpec
- prd + techSpec + acceptanceSpec
- empty Planning Artifacts section (all three null)

Each case must fail closed if the regex regresses (returns `null` for a
slot whose ID is present in the fixture body) so the contract is
genuinely locked.
