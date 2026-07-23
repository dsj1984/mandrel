# Git & Version Control Conventions

This rule applies globally to all repository changes. It is the **always-on
core**: branch shapes, the Conventional-Commit subject contract, issue
references, and the non-negotiable push/hygiene MUSTs. Deeper mechanics —
the hard-cutover contract policy, the full push-validation procedure and
the push-hook false-negative signature, checkout-hygiene scope rules,
shared-checkout merge contention, the documentation-freshness gate, and
the `meta::*` labels — live in the on-demand
[`git-conventions-reference.md`](git-conventions-reference.md); read it
**before** doing the matching work.

## Canonical Branching (v2)

Every Story lands on a dedicated **Story branch** named
`story-<storyId>`, seeded from `project.baseBranch` (`main` by default).
The runtime owns branch creation via `single-story-init.js`; agents
commit on that branch only. Close opens a PR against `main` (squash +
required checks). No `epic/<id>` integration branch, no `--no-ff` wave
merge, no child tickets: commits land on `story-<storyId>` directly, the
subject referencing the Story via `(refs #<storyId>)` — see
[`.agents/instructions.md` § 5.D](../instructions.md).

## Conventional Commits

- MUST follow `<type>(<optional scope>): <description>`, imperative
  mood.
- Types: `feat:`, `fix:`, `perf:`, `refactor:`, `revert:`, `docs:`,
  `style:`, `chore:`, `test:`, `build:`, `ci:` — mirrors
  `changelog-sections` in `release-please-config.json`; keep in sync.
- The `commit-msg` Husky hook runs `commitlint` on every local commit.
  It does **not** run on squash-merge titles edited in the GitHub UI —
  author the PR title in conventional form so the squash commit parses
  for release-please.

## Push Validation & Reliability (MUSTs)

1. Run the configured validation commands locally **before** `git push`.
2. Do NOT assume a push succeeded unless the output confirms the remote
   ref was updated (`[new branch]`, `[up to date]`, `... -> ...`).
3. If a `pre-push` hook rejects, fix the cause and create a NEW follow-up
   commit — never amend the rejected commit.
4. **Never bypass hooks** (`--no-verify`, `--no-gpg-sign`, …) without
   explicit operator authorization. The one recognized exception — a
   Biome zero-match failure under a harness-managed worktree path — is a
   consumer-tooling gap, **not** authorization; see
   [`git-conventions-reference.md` § Push Validation](git-conventions-reference.md).

## Local checkout hygiene

**The delivering flow owns tidying the local checkout** — it
fast-forwards the base branch itself and reaps its own merged refs on
the next workflow boot (the `boot-sweep.js` protected sweep).
`/git-cleanup` is a recovery tool, not a routine chore — never end a
workflow by telling the operator to run it. Scope rules and the
shared-checkout contention guard:
[`git-conventions-reference.md` § Local checkout hygiene](git-conventions-reference.md).

## Pull Requests

- Never commit `.env` or hardcoded secrets.
- Always include a short description of _why_ the change was made.
- Reference issues: "Resolves #109" / "Closes #114".
