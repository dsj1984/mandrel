# Install & Bootstrap Review

- **Date:** 2026-06-10
- **Reviewed at:** `mandrel` v1.54.0, `create-mandrel` v0.3.0 (commit `a7ff890e`)
- **Scope:** the full install/bootstrap surface — `create-mandrel` launcher, `bin/mandrel.js` + `bin/postinstall.js`, `lib/cli/*` (sync / update / doctor / uninstall / migrate / explain / sync-commands), the `.agents/scripts/bootstrap.js` pipeline and its `lib/bootstrap/` helpers, `agents-bootstrap-github.js`, npm packaging, the Install Matrix CI, and every document that describes getting started (`README.md`, `.agents/README.md`, `create-mandrel/README.md`, `AGENTS.md`, `.agents/docs/SDLC.md`, `.agents/workflows/onboard.md`, `.agents/docs/configuration.md`).
- **Method:** five parallel deep-dive code/doc reviews (CLI internals, bootstrap pipeline, documentation consistency, packaging + CI, end-to-end new-user UX trace), with the highest-impact claims independently re-verified against the live npm registry and the workflow YAML.

## Verdict

The individual pieces are well-engineered — small entry points, injectable seams, ~2,800 lines of bootstrap tests, honest doc-comments — but the install story as a whole is broken at the front door and inconsistent behind it. `mandrel` is published and healthy; the advertised cold-start command `npx create-mandrel` is not usable because the launcher package has never been published under any name, and the unscoped name it advertises is currently squattable. The docs describe four different install paths, two of which are stale, and a new user following the guided path hits two *guaranteed* failures (gh `project` scope, doctor's `github-token` check). Below that sit a handful of real bugs (one data-loss, one secret-push hazard, one duplicate-resource-creation), a recurring package-root-vs-consumer-root anchoring bug family, and a vestigial consent layer left behind by recent cutovers.

## High-priority story tracker

Stories were filed for every P0 and P1 recommendation.

**✅ Status: RESOLVED (2026-06-10).** All nine high-priority Stories
(#3891–#3899) have been delivered and merged to `main`. Every P0 front-door
break (§A) and every P1 correctness/safety bug (§B.1–B.5) below that carried a
Story is fixed. The remaining un-storied findings (§B.6–B.9, §C, §D) are P2/P3
and remain open as future work. The findings text below is retained as the
historical review record.

| Story | Priority | Finding | Summary | Resolution |
| --- | --- | --- | --- | --- |
| [#3891](https://github.com/dsj1984/mandrel/issues/3891) | P0 | A.1 | Publish the `create-mandrel` launcher and resolve its package name | ✅ [PR #3914](https://github.com/dsj1984/mandrel/pull/3914) (`ed46c9e3`) |
| [#3892](https://github.com/dsj1984/mandrel/issues/3892) | P0 | A.2, A.3 | Rewrite install quickstart + SDLC Phase 0 around the canonical path | ✅ [PR #3913](https://github.com/dsj1984/mandrel/pull/3913) (`cd128d97`) |
| [#3893](https://github.com/dsj1984/mandrel/issues/3893) | P0 | A.4, A.5 | Stop doctor + bootstrap preflight from false-blocking on auth | ✅ [PR #3915](https://github.com/dsj1984/mandrel/pull/3915) (`e7f12c8`) |
| [#3894](https://github.com/dsj1984/mandrel/issues/3894) | P1 | B.1 | Fix the cold-start secret-push hazard (gitignore before staging) | ✅ [PR #3918](https://github.com/dsj1984/mandrel/pull/3918) (`37358d2d`) |
| [#3895](https://github.com/dsj1984/mandrel/issues/3895) | P1 | B.2 | Make `mandrel uninstall` preserve a pre-existing `.agentrc.json` | ✅ [PR #3919](https://github.com/dsj1984/mandrel/pull/3919) (`ebdfd37`) |
| [#3896](https://github.com/dsj1984/mandrel/issues/3896) | P1 | B.3 | Dedupe Projects V2 board creation on bootstrap re-run | ✅ [PR #3920](https://github.com/dsj1984/mandrel/pull/3920) (`84e6e20`) |
| [#3897](https://github.com/dsj1984/mandrel/issues/3897) | P1 | B.4 | Thread a real GitHub-admin consent signal | ✅ [PR #3921](https://github.com/dsj1984/mandrel/pull/3921) |
| [#3898](https://github.com/dsj1984/mandrel/issues/3898) | P1 | B.5 | Exit non-zero when the GitHub-side bootstrap fails | ✅ [PR #3922](https://github.com/dsj1984/mandrel/pull/3922) (`06296213`) |
| [#3899](https://github.com/dsj1984/mandrel/issues/3899) | P0/P1 | A.6 | End bootstrap with an offered commit + push of the wiring | ✅ [PR #3923](https://github.com/dsj1984/mandrel/pull/3923) |

## npm publication status (verified)

| Package | Declared name | Registry status |
| --- | --- | --- |
| Framework | `mandrel` | **Published** — 1.54.0 is `latest`; the only package in the `mandrelai` org (`npm access list packages mandrelai`) |
| Launcher | `create-mandrel` (unscoped) | **Publish wired (Story #3891)** — at review time E404 for both `create-mandrel` and `@mandrelai/create-mandrel`. [PR #3914](https://github.com/dsj1984/mandrel/pull/3914) added the `npm-publish-launcher` job (gated on the launcher's own per-path `release_created`) and set `publishConfig.access: public` + `provenance: true`; the name is claimed on the next release that bumps the launcher version. |

Two consequences for the launcher:

1. **`npx create-mandrel` fails for every user today**, despite being advertised by `create-mandrel/README.md`, `onboard.md`, and the bootstrap docs. [release-please.yml](../.github/workflows/release-please.yml) has exactly one `npm publish` step (repo root → `mandrel`); release-please has tagged `create-mandrel-v0.2.0`/`v0.3.0`, but no job publishes the launcher.
2. **The unscoped name is a squatting risk.** Because the docs advertise an unregistered name, anyone could publish a malicious `create-mandrel` to the public registry and every user following the docs would execute it. A naming decision is needed before (or as part of) first publish:
   - Keep the unscoped `create-mandrel` name (required for the `npm create mandrel` convention and the `npx create-mandrel` command as documented) and publish it promptly to claim the name; or
   - Move it under the org as `@mandrelai/create-mandrel` for scope consistency — in which case the documented command must change to `npm create @mandrelai/mandrel` (or `npx @mandrelai/create-mandrel`).

Also latent in the release workflow: `release_created` fires if *either* package releases, so a launcher-only release would re-run `npm publish` on an already-published root version and fail.

> **Decision (Story #3891): keep the unscoped `create-mandrel` name.** The
> launcher stays unscoped to preserve the `npm create mandrel` /
> `npx create-mandrel` convention every doc already advertises, so no
> documented invocation changes. `create-mandrel/package.json` carries
> `publishConfig.access: "public"` (+ `provenance: true`); the new
> `npm-publish-launcher` job in
> [`release-please.yml`](../.github/workflows/release-please.yml) publishes
> it on its own release output. Both publish jobs are now gated on their
> package's **per-path** `release_created` output (`.` for the root,
> `create-mandrel` for the launcher), closing the latent
> root-republish-on-launcher-release bug. Publish lands on the next release
> that bumps the launcher version; until then the name is claimed by the
> first release cut after this change.

## A. The front door is broken or misdocumented (highest priority)

1. **The launcher is unpublished and its name unclaimed.** See "npm publication status" above. **→ Story [#3891](https://github.com/dsj1984/mandrel/issues/3891)**
2. **The root [README.md](../README.md) tells a pre-v1.54 story.** It requires a pre-existing git repo and GitHub remote ("Create the empty GitHub repo first") — false since cold-start provisioning landed (`git init` → `gh repo create --push` → `gh project create` in [bootstrap.js](../.agents/scripts/bootstrap.js)). It never mentions `npx create-mandrel` or `/onboard`. Neither does [.agents/README.md](../.agents/README.md). **→ Story [#3892](https://github.com/dsj1984/mandrel/issues/3892)**
3. **[SDLC.md](../.agents/docs/SDLC.md) Phase 0 is dead.** It instructs `cp starter-agentrc.json`, filling in an `orchestration` block (no such schema key — it's `github`), then running `/agents-bootstrap-github` — a command in the lint `RETIRED_COMMANDS` blocklist that survives only because it's backticked. The canonical narrative document starts new users with a command that doesn't exist. **→ Story [#3892](https://github.com/dsj1984/mandrel/issues/3892)**
4. **First run fails on gh scope, undocumented.** A vanilla `gh auth login` token lacks the `project` scope, so the preflight in [gh-preflight.js](../.agents/scripts/lib/bootstrap/gh-preflight.js) hard-fails the very first bootstrap → browser → re-run loop. No README mentions `gh auth refresh -s project` — and the GitHub-side code already knows how to degrade gracefully for the same condition, so preflight is stricter than the code it guards. **→ Story [#3893](https://github.com/dsj1984/mandrel/issues/3893)**
5. **The doctor `github-token` check is a false-blocking gate.** `runGithubToken` ([registry.js:150](../lib/cli/registry.js)) reads only `process.env`; the `mandrel` CLI never loads `.env` (verified — no env-loader anywhere under `bin/` or `lib/`), yet the printed remedy says "(or add to .env)" and `/onboard` both instructs exactly that and treats red doctor as a hard stop. The actual runtime falls back to `gh auth token`, so doctor blocks on a variable the framework doesn't need locally. **→ Story [#3893](https://github.com/dsj1984/mandrel/issues/3893)**
6. **Nobody tells the user to commit and push the wiring.** Story delivery runs in worktrees that contain only *tracked* files, so an uncommitted `.agents/`/`.agentrc.json` breaks every sub-agent. This mandatory step appears in no README and no bootstrap output — the most likely "worked in my checkout, broke in delivery" trap. **→ Story [#3899](https://github.com/dsj1984/mandrel/issues/3899)**

## B. Correctness and safety bugs

1. **Secret-push hazard (High).** Cold-start provisioning runs `git add -A` + initial commit, then `gh repo create --push` — and the `.gitignore` seeding runs **two phases later**. A folder containing `.env` or `.mcp.json` gets them pushed to the brand-new repo with no per-file consent. `GITIGNORE_BLOCKS` in [project-bootstrap.js](../.agents/scripts/lib/bootstrap/project-bootstrap.js) also omits `.env` entirely, while `/onboard` tells users to put `GITHUB_TOKEN` in `.env`. This violates the repo's own security baseline. Fix: empty initial commit (no `add -A`) or reorder gitignore before staging, and add `.env` + the install ledger to the blocks. **→ Story [#3894](https://github.com/dsj1984/mandrel/issues/3894)**
2. **`mandrel uninstall` can delete a hand-authored `.agentrc.json` (High, data loss).** `revertAgentrc` ([uninstall.js:442](../lib/cli/uninstall.js)) deletes unconditionally, but the ledger records the *full manifest filtered by phase group*, never the execution-time "already-present" no-op — so a pre-existing operator config gets ledgered as install-created and later removed. **→ Story [#3895](https://github.com/dsj1984/mandrel/issues/3895)**
3. **Re-running bootstrap with `--assume-yes` creates a duplicate Projects V2 board every run** and re-points `.agentrc.json` at it. The project question defaults to the repo *name* (never the stored `projectNumber`), any non-numeric answer is classified "create new," and `gh project create` is never deduped against existing titles — directly contradicting the docstring's "a re-run is a no-op." The repo side got exactly this fix; the project side didn't. **→ Story [#3896](https://github.com/dsj1984/mandrel/issues/3896)**
4. **Consent is hardcoded.** [bootstrap.js](../.agents/scripts/bootstrap.js) passes `githubAdminApproved: true` into the GitHub bootstrap, and a non-TTY run with just `--owner/--repo` (no `--assume-yes`, despite help text claiming it's required) auto-approves repo/board/label creation. Only branch protection and merge methods stay HITL-gated. **→ Story [#3897](https://github.com/dsj1984/mandrel/issues/3897)**
5. **GitHub-side bootstrap failure exits 0.** `executeGithubBootstrap` catches the error into the report and `main()` prints `Done.` — invisible to `create-mandrel` and CI, while preflight/provisioning failures correctly exit 1. **→ Story [#3898](https://github.com/dsj1984/mandrel/issues/3898)**
6. **`mandrel update` ends with three quiet failures:** changelog surfacing can never work in a consumer (default path is `docs/CHANGELOG.md`, which isn't in the npm `files` allowlist — every real update logs "skipping"); the explicit update resolves through the 24h cache, so it can report "already up to date" without ever hitting the registry; and it never runs `sync-commands` yet gates on the `commands-in-sync` doctor check it didn't establish.
7. **Anchoring bug family (the recurring root cause).** Three places confuse package root with consumer root, the exact bug class Story #3588 fixed once: the `runtime-deps` doctor check resolves from inside `node_modules/mandrel` so it *can never fail* where it matters (and is currently masking an analytically real pnpm isolated-layout breakage of the "scripts free-ride on consumer node_modules" contract); the version cache writes to `node_modules/mandrel/temp/`, wiped by every reinstall. Anchor all of them at `process.cwd()` like `agents-materialized`/`agents-drift` already do.
8. **`mandrel sync` never prunes and `agents-drift` only checks payload files**, so a file deleted upstream lingers (and keeps projecting its slash command) in consumer `.agents/` forever, doctor all-green — contradicting both sync's "byte-identical" claim and the hard-cutover doctrine.
9. **Prompt polarity trap:** four `[Y/n]` prompts, then the final merge-methods gate flips to `[y/N]` — and drift is guaranteed on fresh repos, so Enter-through silently disables the auto-merge half of the pipeline, surfacing weeks later as `/epic-deliver` warn-only failures.

## C. Unnecessary complexity and dead code

1. **The consent/preview machinery is vestigial.** Since Story #3690 removed phased approval, the phase-group gate always passes, `previewMutationManifest` has zero production callers, `--dry-run` doesn't render the manifest its docstring promises, and the manifest omits the *most* irreversible mutations (git init, repo/board creation) — so uninstall's ledger never hears about them either. Either wire it into `--dry-run` + ledger fully, or collapse it.
2. **Confirmed dead code:** `--install-workflows` (parsed, never read), `ensureCiWorkflow` (zero production callers — which also means the advertised branch-protection/CI story is unreachable on a default install), `ensureMainBranchProtection` (kept only for legacy contract tests, duplicates `applyBranchProtection`), `mandrel sync --force` (documented no-op), `__filenameForTests` (unimported), an unreachable `--skip-github` notice, and a stale remediation hint pointing at retired `/agents-bootstrap-project`.
3. **Quadruplicated helpers:** four independent lockfile-probe implementations, four `parseVersion`/`compareVersions` copies, and [registry.js](../lib/cli/registry.js) maintaining verbatim mirrors of sync.js's resolver/walker via "Mirrors lib/cli/sync.js" comments instead of imports. [update.js](../lib/cli/update.js) also carries a redundant second DI layer and a "no-drift" `STEP_PLAN` whose live and dry-run paths have already drifted.
4. **TypeScript is declared three incompatible ways:** hard runtime dep (`>=5.0.0`, unbounded), non-optional peer, and gracefully-degrading optional in the one real consumer (the maintainability gate). Every pure-JS consumer downloads the TS compiler; any TS4 consumer gets ERESOLVE. Make it a truly optional peer.
5. **`engines: ">=22.22.1 <25"`** — patch-specific floor introduced wholesale in the v6 cutover with no recorded rationale, duplicated in four places, and a hard install error under pnpm/yarn for consumers on earlier 22.x.
6. **CLI surface gaps:** bare `mandrel` prints no subcommand list; no `--help`/`--version`; `registry.js`/`version-check.js` sit in the convention-dispatched directory but crash via the dispatcher; `uninstall`, `explain`, and `sync-commands` are documented nowhere consumer-facing; the most destructive command (`uninstall`) is the only mutating one without `--dry-run`; no subcommand rejects unknown flags, so `mandrel update --dryrun` (typo) performs a live install.

## D. Packaging & CI gaps

1. **Tarball is healthy** (1.9 MB, 856 files, everything sync needs) except: 7 `__tests__` files ship in `lib/`, and `"main": "index.js"` dangles (no such file). `.npmrc ignore-scripts=true` and the postinstall source-checkout guard are both sound.
2. **The Install Matrix never exercises:** postinstall materialization (every leg uses `--ignore-scripts` — exactly the path that already shipped the Story #3584 regression), the create-mandrel cold start (one pure-function unit test), or running a single materialized script from the consumer root (which would immediately expose the pnpm free-ride breakage that finding B.7 is masking).
3. **`create-mandrel` installs floating `latest`** with lifecycle scripts enabled, then runs the sync the postinstall already did — pin the framework version per release and pass `--ignore-scripts`. The version-sync pre-commit guard also only checks the root manifest entry, and the launcher's changelog shows it being version-bumped by unrelated root work.
4. **`knip` never scans `bin/`, `lib/`, or `create-mandrel/`** — the entire npm distribution surface is invisible to the dead-code gate; it already flags ~10 bootstrap-refactor leftovers in the areas it does scan.
5. **Doc nits:** `mandrel` (missing `ai`) typos in two places, `AGENTS.md` says "License: ISC" vs MIT everywhere else, and the three-agentrc-files table is maintained in two places that have already drifted from each other.

## What's healthy

`create-mandrel/index.js`, `bin/mandrel.js`, and `bin/postinstall.js` are exemplary — small, pure-planned, seam-injected, honestly documented. The bootstrap pipeline is a single readable 10-phase array; file-side idempotency (markers, minimal writes, operator-wins `.agentrc.json`) is genuinely hardened and tested; no prompt can hang in CI; `/onboard` vs `bootstrap.js` division of labor is explicit and clean; `create-mandrel/README.md` and `onboard.md` match their code exactly; `mandrel` publishing (provenance, `publishConfig.access`, source-checkout guard) is correctly set up.

## Prioritized recommendations

**P0 — unbreak the front door:**

- Decide the launcher's name (unscoped `create-mandrel` for the `npm create mandrel` convention vs `@mandrelai/create-mandrel` for org consistency), publish it, and add the second publish step to `release-please.yml` gated on the launcher's own release output. Until it ships, stop advertising `npx create-mandrel`. — Story [#3891](https://github.com/dsj1984/mandrel/issues/3891)
- Rewrite the README quickstart + SDLC Phase 0 around the one canonical path (`npx create-mandrel` → `/onboard`). — Story [#3892](https://github.com/dsj1984/mandrel/issues/3892)
- Make the `github-token` doctor check accept the `gh auth token` fallback (or load `.env`); document or soften the `project`-scope preflight. — Story [#3893](https://github.com/dsj1984/mandrel/issues/3893)

**P1 — safety:**

- Gitignore-before-stage ordering plus `.env` in `GITIGNORE_BLOCKS`. — Story [#3894](https://github.com/dsj1984/mandrel/issues/3894)
- Content-aware `.agentrc.json` reversal in uninstall (or outcome-aware ledger). — Story [#3895](https://github.com/dsj1984/mandrel/issues/3895)
- Dedupe project-board creation on re-run. — Story [#3896](https://github.com/dsj1984/mandrel/issues/3896)
- Real consent signal instead of `githubAdminApproved: true`. — Story [#3897](https://github.com/dsj1984/mandrel/issues/3897)
- Non-zero exit on GitHub-side failure. — Story [#3898](https://github.com/dsj1984/mandrel/issues/3898)
- End bootstrap with an offered "commit + push the wiring" step. — Story [#3899](https://github.com/dsj1984/mandrel/issues/3899)

**P2 — consistency & weight:**

- Fix the three `process.cwd()` anchoring bugs; add prune-or-flag-extras to sync/drift.
- Insert `sync-commands` into the update cycle and ship the changelog.
- Collapse or fully wire the consent/preview layer; delete the confirmed dead code; unify the version/lockfile helpers.
- TypeScript → optional peer; justify or lower the engines floor.
- Add a subcommand list + unknown-flag rejection + `uninstall --dry-run`; document `uninstall`/`explain`/`sync-commands`.

**P3 — CI:**

- One scripts-enabled npm leg asserting postinstall materialization.
- A registry-backed (e.g. verdaccio) create-mandrel cold-start leg.
- Run one materialized script from the consumer dir per leg.
- Extend knip to `bin/`/`lib/`/`create-mandrel/`; extend the version-sync guard to both manifest entries.

## UX bottom line

Today a careful new user needs **~12–18 operator actions with two guaranteed failures** to reach a deliverable Epic, and the "15 minutes" claim only covers the slice `/onboard` measures — realistically 30–60 minutes. The P0+P1 items collapse that to: `npx create-mandrel` → ~4 answers → "commit & push? [Y]" → `/onboard` → green doctor.
