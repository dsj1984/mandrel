# AgentLinter Baseline Report

This is the **first baseline** capture of what
[AgentLinter](https://agentlinter.com/) (`npx agentlinter`, MIT) flags on
Mandrel's own agent-config surface, recorded when the advisory CI check was
wired in (Story #3279).

- **Tool version:** `agentlinter@0.3.3` (pinned)
- **Captured:** 2026-05-28, against the `story-3279` tree
- **How to reproduce:** the same two invocations the `agentlinter (advisory)`
  CI job runs (see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)):

  ```bash
  npx --yes agentlinter@0.3.3 --local        # root CLAUDE.md / AGENTS.md
  npx --yes agentlinter@0.3.3 .agents --local # distributed .agents/ bundle
  ```

> **Status:** advisory only. This report is a snapshot for triage, **not** a
> to-do list scoped to Story #3279. Acting on / remediating any finding below
> is explicit follow-up work (out of scope per the Story). The check is
> non-blocking; see the "Advisory CI checks" note in
> [`AGENTS.md`](../AGENTS.md) for the blocking-vs-advisory distinction.

## Why two scans

AgentLinter combines either a single root scan (which discovers root
`CLAUDE.md` / `AGENTS.md`) **or** a subdirectory scan (which recurses that
subtree's `*.md` files), but not both in one pass. To cover the whole
agent-config surface the CI job runs it twice — once at repo root and once
scoped to `.agents/`. The two runs therefore report independently (e.g. the
`.agents/` run flags "No CLAUDE.md found" because that file lives at the root,
outside the scoped subtree).

## Scan 1 — root agent configs (`CLAUDE.md`, `AGENTS.md`)

**Overall: 85/100 (B+)** — 1 critical, 10 warnings, 13 suggestions.

| Dimension    | Score |
| ------------ | ----- |
| Structure    | 99 (S) |
| Clarity      | 34 (F) |
| Completeness | 95 (A) |
| Security     | 95 (A) |
| Consistency  | 100 (S) |
| Memory       | 100 (S) |
| Runtime      | 99 (S) |
| SkillSafety  | 100 (S) |

Headline findings:

- **Critical** — `AGENTS.md`: a "vague conditional" in the release-please PAT
  section ("update workflow files when needed)").
- **Warnings** — "no prompt-injection defense found" (workspace-level);
  several "absolute rule without escape hatch" hits on Markdown headings and
  `MUST` statements; "compound instruction" and "vague instruction" hits;
  "no tool documentation found" on `CLAUDE.md`.
- **Suggestions** — undefined-acronym tips (`MUST`, `SDLC`, `ISC`, `TDD`,
  `CRAP`, `MIT`, `TAP`, `PAT`, `OR`), "no version/update date", "no examples"
  on `CLAUDE.md`, and "no runtime config".

The Clarity score (34/F) reflects AgentLinter's heuristic flagging of
Mandrel's deliberately absolute, cross-referential instruction style — exactly
the noise this Story anticipated, and the reason the check stays advisory.
The high-value Security (95/A) and SkillSafety (100/S) dimensions are clean.

## Scan 2 — distributed `.agents/` bundle (skills, personas, rules)

**Overall: 91/100 (A-)** — 1 critical, 5 warnings, 50 suggestions.

| Dimension    | Score |
| ------------ | ----- |
| Structure    | 90 (A-) |
| Clarity      | 100 (S) |
| Completeness | 81 (B) |
| Security     | 100 (S) |
| Consistency  | 100 (S) |
| Memory       | 100 (S) |
| Runtime      | 99 (S) |
| SkillSafety  | 50 (D) |

Headline findings:

- **Critical** — "No CLAUDE.md or AGENTS.md found": an artifact of scoping the
  scan to the `.agents/` subtree (those entry points live at the repo root,
  covered by Scan 1). Not a real gap.
- **SkillSafety 50/D** — driven by two "potential injection vector in skill"
  tips on
  `skills/core/browser-testing-with-devtools/SKILL.md`, which fire on the
  skill's own text **defending against** prompt injection (e.g. lines that
  quote `"Ignore previous instructions..."` as an example of input to treat as
  data). These are false positives on defensive guidance, worth confirming
  during triage.
- **Warnings** — workspace-level "no identity/persona", "no tool
  documentation", "no boundaries", "no prompt-injection defense" (again,
  scoping artifacts since these live in root/other files), plus a "dangerous
  command: dynamic eval execution" hit on
  `skills/core/security-and-hardening/SKILL.md:19` that fires on prose telling
  authors **not** to use `eval()` — another defensive-text false positive.
- **Suggestions** — the bulk (≈45) are "Skill missing author field" frontmatter
  tips across every `SKILL.md`, plus workspace-level "no error handling / output
  format / workflow / priority guidance" and "no runtime config" tips.

## Triage notes for follow-up (not in scope here)

- Several high-severity-looking findings (injection vectors, "dangerous
  command: eval") are **false positives on defensive text** — the linter
  matches the attack patterns the docs explicitly warn against. Confirm before
  acting.
- The "missing author field" frontmatter tip is a consistent, low-risk
  candidate if the team wants to attribute skills.
- The scoping artifacts ("no CLAUDE.md", "no persona/boundaries/tools" in the
  `.agents/` scan) are expected given the two-pass approach and need no action.
