---
description: >-
  Print the Mandrel-owned slash-command catalog — every workflow under
  `.agents/workflows/` (top-level, not `helpers/`) with its description. Use
  this when you want to see what's Mandrel vs. built-in Claude Code.
---

# /mandrel

## Overview

`/mandrel` is the **discoverability entry point** for the Mandrel-owned
slash-command surface. It prints a catalog of every workflow that lives under
`.agents/workflows/` (top-level only — `helpers/` are path-included modules,
not runnable commands). Consumers run `/mandrel` once to learn what the
framework adds to Claude Code's built-in `/` menu, then use the descriptive
per-command names day-to-day.

This is the **one** place a brand-prefixed command makes sense — the entry
point itself, not the per-command names. The naming-discipline rule
(`docs/decisions.md`) keeps every other command described by what it does
(`/epic-deliver`, `/audit-clean-code`, `/story-deliver`, etc.) rather than
forcing `mandrel-` on every entry.

## Procedure

Run this Node one-liner from the project root. It walks
`.agents/workflows/*.md`, parses each frontmatter `description:` field, and
prints the catalog to stdout:

```bash
node --input-type=module -e "import('./.agents/scripts/lib/mandrel-catalog.js').then(m => { const c = m.buildCatalog('.agents/workflows'); process.stdout.write(m.renderCatalog(c)); });"
```

The catalog is **auto-generated** at invocation time — never stored on disk.
The single source of truth is the on-disk workflow set; if a workflow file is
added, removed, or has its frontmatter description tightened, the next
`/mandrel` reflects the change without any sync step.

Entries flagged `⚠️ vague` carry a description shorter than 30 characters or
no description at all. These are nudges for the maintainer, not blockers —
a vague entry still renders. The description-frontmatter audit (Epic F Story
1601, Task 1619) was the one-time sweep that brought the existing surface
into shape; the vague-flag exists so the catalog catches regressions.

## What `/mandrel` is not

- **Not a writer.** No GitHub I/O, no commit creation, no label transitions,
  no file mutations. Pure read-of-disk + stdout, like `/signals` and
  `/diagnose`.
- **Not a sync.** `sync-claude-commands.js` is still the only writer of
  `.claude/commands/`. `/mandrel` reads the workflow set; it doesn't reshape
  the slash-command catalog Claude Code surfaces in its `/` menu.
- **Not a docs index.** Workflow long-form docs live in each workflow's own
  body and in `docs/workflows.md`. `/mandrel` is a one-line-per-command
  menu, not a reference manual.

## Coupling stance

The catalog generator (`lib/mandrel-catalog.js`) is pure, runtime-neutral, and
test-covered — same stance as the rest of `lib/`. The `/mandrel` workflow itself
leans on the Claude Code `/` menu as the surfacing channel; that's the
declared workflow-layer coupling from the Epic G #1471 ADR. Portability of the
slash-command surface is a non-goal.

## Constraints

- **Never** write to disk. The catalog is generated at invocation time; no
  rendered artifact is stored. Drift between an on-disk cache and the live
  workflow set would defeat the purpose.
- **Never** mutate GitHub state. `/mandrel` is read-only — no labels, no
  comments, no issue updates. Same operator-affordance contract as `/signals`
  and `/diagnose`.
- **Never** include the `helpers/` subdirectory. Helpers are path-included
  modules, not runnable workflows; surfacing them in the catalog would
  mislead operators into typing them as slash commands.
- **Always** keep the catalog generator pure (no provider factory, no
  `gh` shell-out). The unit test under `tests/lib/mandrel-catalog.test.js`
  is the load-bearing regression guard.
