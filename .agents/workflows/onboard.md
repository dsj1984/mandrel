---
description: >-
  Guided first-run onboarding for a freshly installed Mandrel. Detects the
  consumer stack, offers to scaffold any missing docsContextFiles, runs
  `mandrel doctor` as a readiness gate, and hands off to a started /epic-plan.
  The whole path is designed to take about 15 minutes from a clean checkout to
  a planned Epic.
---

# /onboard

## Role

Onboarding guide. You walk a first-time operator from a freshly installed
Mandrel to their first planned Epic, composing the building blocks shipped by
the guided-onboard Feature (#3514): stack detection, docs scaffolding, the
`mandrel doctor` readiness check, and a started `/epic-plan` handoff.

## Overview

`/onboard` is the **guided first-successful-run path**. It sequences four
phases that each lean on an already-shipped, independently tested building
block, then hands the operator off to planning:

```text
/onboard
  → Phase 1 — Detect stack          (lib/onboard/detect-stack.js#detectStack)
  → Phase 2 — Offer docs scaffolding (lib/onboard/scaffold-docs.js#scaffoldDocs)
  → Phase 3 — Readiness gate         (mandrel doctor → lib/cli/doctor.js)
  → Phase 4 — Handoff to /epic-plan  (started, not auto-run)
```

Each phase is **advisory and resumable**: re-running `/onboard` on an
already-onboarded project re-detects, re-checks, and offers the same handoff
without duplicating any scaffolding (the scaffolder only writes files that are
genuinely missing, and `mandrel doctor` is read-only).

### When to use `/onboard`

| Scenario | Command |
| --- | --- |
| First run after installing Mandrel into a project | `/onboard` |
| Plan a new Epic once onboarded | `/epic-plan <epicId>` or `/epic-plan --idea "<seed>"` |
| Deliver Epic-attached Stories | `/epic-deliver <epicId>` |

## Prerequisites

1. Mandrel installed and bootstrapped into the project. The zero-to-installed
   path is `npx mandrel init`, which installs the `mandrel`
   package (when absent), runs `mandrel sync` to materialize the `.agents/`
   bundle, and then — on the **configure now** prompt option — execs
   `.agents/scripts/bootstrap.js` to provision the project (labels,
   board, `.agentrc.json` seed). `/onboard` runs **after** that bootstrap
   completes — it does not invoke `bootstrap.js` itself, so the coupling is
   indirect: bootstrap owns first-time provisioning, `/onboard` owns the
   guided first-successful-run. By the time you reach `/onboard`, the
   `.agents/` bundle is present and `mandrel` resolves on the `PATH`.
2. `GITHUB_TOKEN` available in the project's `.env` (Phase 3 checks this; the
   token value is never echoed).

## The ~15-minute first-successful-run path

`/onboard` is tuned so a brand-new operator can go from a clean checkout to a
planned Epic in roughly **15 minutes**. The budget breaks down as:

| Step | Phase | Rough budget |
| --- | --- | --- |
| Detect the stack and confirm the report | Phase 1 | ~1 min |
| Review the missing-docs offer and accept the scaffold | Phase 2 | ~3 min |
| Run `mandrel doctor` and clear any ✘ checks | Phase 3 | ~5 min |
| Start `/epic-plan` and describe the first Epic idea | Phase 4 | ~6 min |

If any single phase blows its budget — most often a Phase 3 remedy such as
authenticating `gh` or installing runtime deps — clear that one check and
re-run `/onboard`; the earlier phases are cheap and idempotent, so re-running
costs seconds.

### Sample-repo pointer

If you do not have a project to onboard yet and just want to see the path
end-to-end, point `/onboard` at the **stack-detection sample-repo fixture**
that ships with the framework. `detectStack` is fixture-driven by design (its
filesystem facade reads a real directory), and the unit suite exercises it
against an on-disk sample repo — see
[`tests/onboard/detect-stack.test.js`](../../tests/onboard/detect-stack.test.js),
which builds a sample repo with a lockfile, a `package.json`, and source files
and asserts the detected package manager, test runner, and primary language.
Use that fixture (or any small throwaway repo with a `package.json` and a few
source files) as the target for a dry first run before onboarding a real
project.

## Phase 1 — Detect the stack

Inspect the consumer repository root and report what Mandrel inferred before
touching anything. Use the detection helper shipped by Story #3520:

```bash
node -e "import('./.agents/scripts/lib/onboard/detect-stack.js').then(m => console.log(JSON.stringify(m.detectStack(process.cwd()), null, 2)))"
```

`detectStack(root)` returns `{ packageManager, testRunner, primaryLanguage }`,
each inferred from on-disk signals (lockfiles, `package.json`, source-file
extensions) and `null` when no signal is found. Relay the report to the
operator so they can confirm Mandrel understood the project. Detection is
**read-only** — it never writes to disk — so a wrong guess is harmless and the
operator can simply correct course in their `.agentrc.json` later.

## Phase 2 — Offer to scaffold missing `docsContextFiles`

Mandrel agents perform a **mandatory read** of every file listed in
`project.docsContextFiles` before each task; a missing entry degrades every
downstream run. Detect which are absent and offer to scaffold stubs, using the
helper shipped by Story #3519:

1. **Preview (no writes).** Detect the missing set first:

   ```bash
   node -e "import('./.agents/scripts/lib/onboard/scaffold-docs.js').then(m => console.log(JSON.stringify(m.scaffoldDocs({ write: false }), null, 2)))"
   ```

   `scaffoldDocs({ write: false })` returns `{ docsRoot, docsContextFiles,
   missing, present, created }` without creating any files.

2. **Offer.** Show the operator the `missing` list and ask whether to scaffold
   stubs. If the list is empty, report "all docsContextFiles present" and skip
   to Phase 3.

3. **Scaffold (on acceptance).** When the operator accepts, write the stubs:

   ```bash
   node -e "import('./.agents/scripts/lib/onboard/scaffold-docs.js').then(m => console.log(JSON.stringify(m.scaffoldDocs({ write: true }), null, 2)))"
   ```

   Each missing file is seeded from a dedicated template under
   `.agents/templates/docs/<name>` when one ships, otherwise from a generic
   placeholder stub. The operator replaces the stub content with real docs
   later; the point of the scaffold is that the mandatory-read never resolves
   to a missing file.

This phase is **idempotent**: the scaffolder only writes files that are
actually absent, so re-running `/onboard` after a partial scaffold creates
only the still-missing stubs.

## Phase 3 — Readiness gate (`mandrel doctor`)

Run the doctor as a **readiness gate** before handing off to planning:

```bash
mandrel doctor
```

`mandrel doctor` (see [`lib/cli/doctor.js`](../../lib/cli/doctor.js)) runs
every check in the registry in order — `node-version`, `git-available`,
`gh-available`, `github-token`, `gh-auth`, `commands-in-sync`, `runtime-deps`,
`agents-materialized`, `agents-drift`, `version-current` — and prints a
`✔`/`✘` line per check. Every failing check prints a `→ <remedy>` line, and
the command exits:

- **0** with `✅  Ready (N/N checks passed)` — proceed to Phase 4.
- **non-zero** with `❌  Not ready (M/N checks failed)` — **stop**. Work
  through the `→` remedies (e.g. authenticate `gh`, set `GITHUB_TOKEN`,
  install runtime deps), then re-run `mandrel doctor` until it is green.

Do **not** hand off to `/epic-plan` while the doctor is red — planning needs a
working `gh` / `GITHUB_TOKEN` and a materialized `.agents/` bundle, exactly
what the gate verifies. The `github-token` check never echoes the token value
(security baseline § Secrets Management).

## Phase 4 — Handoff to a started `/epic-plan`

With a green readiness gate, hand the operator off to planning. `/onboard`
**starts** the handoff — it surfaces the entry point and the idea-refinement
path — but does **not** auto-run `/epic-plan`, because Epic planning authors
GitHub artifacts and must stay under explicit operator control.

Present the operator with the two `/epic-plan` entry shapes:

- **From an idea** (no Epic exists yet):

  ```text
  /epic-plan --idea "<one-line description of the first thing to build>"
  ```

  This enters [`/epic-plan`](epic-plan.md) at Phase 1 (Idea Refinement),
  which refines the seed into a PRD, Tech Spec, and a decomposed
  Epic → Feature → Story backlog.

- **From an existing Epic** (a `type::epic` issue already exists):

  ```text
  /epic-plan <epicId>
  ```

Stop here and let the operator invoke `/epic-plan` themselves. Once they have
a planned Epic, the natural next step is `/epic-deliver <epicId>` to execute
it — but that is beyond the onboarding path.

## Constraints

- **Read-before-write.** Phases 1 and 3 are read-only; Phase 2 writes only
  files that are genuinely missing and only on explicit operator acceptance.
- **Do not auto-run `/epic-plan`.** Phase 4 starts the handoff; the operator
  invokes planning. Planning authors GitHub artifacts and stays under human
  control.
- **Never echo secrets.** The `github-token` check and any token-related
  remedy must not print the token value.
- **Stop on a red doctor.** A non-zero `mandrel doctor` exit blocks the
  handoff until the operator clears the failing checks.
