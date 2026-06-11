# Install & Bootstrap Review — open findings

- **Original review:** 2026-06-10 at `mandrel` v1.54.0 (commit `a7ff890e`)
- **Re-verified:** 2026-06-10 at v1.58.0 (commit `158ebc75`) — every finding
  below was independently re-checked against current `main`; resolved findings
  were removed from this document (the full original record is in this file's
  git history, added in `95fbaaf3`).
- **Scope:** the install/bootstrap surface — `create-mandrel` launcher,
  `bin/mandrel.js` + `bin/postinstall.js`, `lib/cli/*`, the
  `.agents/scripts/bootstrap.js` pipeline and `lib/bootstrap/` helpers,
  `agents-bootstrap-github.js`, npm packaging, the Install Matrix CI, and the
  getting-started docs.

## Status of the original high-priority work

All nine P0/P1 Stories ([#3891](https://github.com/dsj1984/mandrel/issues/3891)–[#3899](https://github.com/dsj1984/mandrel/issues/3899))
were delivered and merged. Since then the surface also gained `mandrel init`
(one-command cold start, `158ebc75`), a doctor gh-auth degrade-to-warn fix
(`76bea3e8`), and the package rename to unscoped `mandrel` (`10bc86e7`). The
findings those resolved — secret-push hazard, uninstall data loss, duplicate
board creation, hardcoded consent, exit-0 GitHub failures, README/SDLC rewrite,
doctor/preflight false-blocking, missing commit+push step — are gone from this
document.

Everything below is **still present at v1.58.0**.

---

## P0 — the launcher is still not on the registry (operational, not code)

Story #3891 wired the publish correctly — `npm-publish-launcher` job gated on
the launcher's per-path `release_created`, `publishConfig.access: public` +
`provenance: true` — and the Story is closed. But **no release bumping
`create-mandrel` has been cut since**, so the publish job has never fired:

- `npm view mandrel version` → `1.58.0` ✅
- `npm view create-mandrel version` → **E404** (verified 2026-06-10)

Consequences are unchanged from the original review: `npx create-mandrel`
fails for every user who follows the docs, and the unscoped name remains
**squattable** until first publish. The missing step is operator/release
action, not code: land any conventional commit scoped to `create-mandrel/`
(or a `Release-As:` trailer) so release-please cuts `create-mandrel-vX.Y.Z`
and the publish job claims the name. Until that happens, `mandrel init`
(post-review) is the only working advertised cold-start path.

---

## B. Correctness bugs (all re-verified still present)

1. **`mandrel update` ends with three quiet failures.**
   - *Changelog surfacing can never work in a consumer:*
     `defaultSurfaceChangelog` ([update.js:436](../lib/cli/update.js)) reads
     `<packageRoot>/docs/CHANGELOG.md`, but `docs/` is not in the npm `files`
     allowlist — every real update logs "skipping".
   - *The explicit update resolves through the 24h cache:*
     `defaultResolveTargetVersion` ([update.js:209](../lib/cli/update.js))
     returns the cached `latestVersion` with zero network I/O when the cache
     is < 24h old, so `mandrel update` can report "already up to date"
     against a stale answer.
   - *It never runs `sync-commands` yet gates on `commands-in-sync`:*
     `STEP_PLAN` ([update.js:528](../lib/cli/update.js)) is
     `npm-update → runSync → runMigrations → doctor`, and the doctor gate
     includes the non-advisory `commands-in-sync` check — so an
     upstream-renamed workflow fails the update exit code even though the
     upgrade succeeded. (`mandrel init`'s bootstrap path does run the command
     sync, but that heals only out-of-band and only on the "configure" path.)
2. **Package-root-vs-consumer-root anchoring family.** The `runtime-deps`
   doctor check ([registry.js:344,371](../lib/cli/registry.js)) resolves from
   inside `node_modules/mandrel`, so it can never fail where it matters and
   masks the pnpm isolated-layout breakage of the "scripts free-ride on
   consumer node_modules" contract. The version cache writes to
   `node_modules/mandrel/temp/version-check.json`
   ([update.js:210](../lib/cli/update.js),
   [registry.js:693](../lib/cli/registry.js)), wiped by every reinstall.
   `commands-in-sync` / `agents-materialized` / `agents-drift` were all
   anchored at `process.cwd()` (Story #3588's pattern); these two were not.
3. **`mandrel sync` never prunes and `agents-drift` only checks payload
   files.** `runSync` ([sync.js:130–190](../lib/cli/sync.js)) enumerates
   source files only with no deletion pass, and `runAgentsDrift`
   ([registry.js:591](../lib/cli/registry.js)) never visits consumer files
   without a payload counterpart — so an upstream-deleted file lingers (and
   keeps projecting its slash command) forever, doctor all-green,
   contradicting both sync's "byte-identical" claim and the hard-cutover
   doctrine.
4. **Prompt polarity trap — and it has grown.** The bootstrap now has *five*
   `[Y/n]` accept-default prompts (Story #3899's commit+push confirm added
   one), then the final merge-methods gate still flips to `[y/N]`
   ([hitl-confirm.js:79](../.agents/scripts/lib/bootstrap/hitl-confirm.js)).
   Merge-method drift is guaranteed on fresh repos
   ([merge-methods.js:26–32](../.agents/scripts/lib/bootstrap/merge-methods.js)
   targets squash-only + auto-merge + delete-on-merge, which differs from
   GitHub defaults), so Enter-through silently records
   `status: 'skipped', reason: 'hitl-declined'` and disables the auto-merge
   half of the pipeline — surfacing weeks later as `/epic-deliver` warn-only
   failures. The #3897 consent rework pre-approves this gate only under
   `--assume-yes`; interactive runs keep the trap.

## C. Unnecessary complexity and dead code

1. **The preview/manifest half of the consent layer is still vestigial.**
   (#3897 fixed the *consent* half — `githubAdminApproved` is now a real
   TTY/flag signal with a default-deny boundary gate.) Still true: the
   project-side phase-group gate always passes
   ([bootstrap.js:1126–1137](../.agents/scripts/bootstrap.js));
   `previewMutationManifest` has zero production callers; `--dry-run` still
   doesn't render the manifest its docstring promises
   ([bootstrap.js:995–1023](../.agents/scripts/bootstrap.js)); and the
   manifest omits git init and repo creation, so uninstall's ledger never
   hears about the most irreversible mutations (#3895's "already-present"
   markers cover only manifest-covered ones). Either wire it fully into both
   `--dry-run` and the ledger, or collapse it.
2. **Confirmed dead code (all seven re-verified):** `--install-workflows`
   (parsed at [agents-bootstrap-github.js:572](../.agents/scripts/agents-bootstrap-github.js),
   never read), `ensureCiWorkflow` (zero production callers — the advertised
   branch-protection/CI story is unreachable on a default install),
   `ensureMainBranchProtection` (kept only for legacy contract tests),
   `mandrel sync --force` (documented no-op), `__filenameForTests`
   (unimported), the unreachable `--skip-github` notice
   ([bootstrap.js:1073–1078](../.agents/scripts/bootstrap.js)), and the stale
   `/agents-bootstrap-project` remediation hints — now found in *four* places
   ([gh-preflight.js:41–48,277](../.agents/scripts/lib/bootstrap/gh-preflight.js),
   [sync-agentrc.js:72](../.agents/scripts/lib/config/sync-agentrc.js),
   [errors/index.js:56](../.agents/scripts/lib/errors/index.js)).
3. **Multiplied helpers (counts updated):** *five* independent lockfile-probe
   implementations (update.js, project-bootstrap.js, runtime-deps/preflight.js,
   onboard/detect-stack.js, worktree/node-modules-strategy.js); four
   `parseVersion`/`compareVersions` copies in the install surface plus a fifth
   comparator in gh-preflight.js; [registry.js:471–507](../lib/cli/registry.js)
   still maintains "Mirrors lib/cli/sync.js" verbatim copies instead of
   imports; [update.js](../lib/cli/update.js) still carries two stacked DI
   layers and a `STEP_PLAN` whose "the two never drift" claim is structurally
   false (the dry-run hand-appends a fifth changelog step outside the
   constant).
4. **TypeScript is still declared three incompatible ways:** hard runtime dep
   (`>=5.0.0`, unbounded), non-optional peer
   (`peerDependenciesMeta.typescript.optional: false`), and a
   gracefully-degrading optional require in the one real consumer
   ([maintainability-utils.js:34–44](../.agents/scripts/lib/maintainability-utils.js)).
   Every pure-JS consumer downloads the TS compiler. Make it a truly optional
   peer.
5. **`engines: ">=22.22.1 <25"`** — patch-specific floor, still no recorded
   rationale, duplicated in four code/config places (root + launcher
   `package.json`, `REQUIRED_NODE_FLOOR` in project-bootstrap.js and its
   registry.js mirror) and echoed in four docs, while CI pins a loose
   `node-version: 22`. Still a hard install error under pnpm/yarn for
   consumers on earlier 22.x.
6. **CLI surface gaps:** bare `mandrel` still prints only
   `Usage: mandrel <subcommand> [args]` with no subcommand list; `--help` /
   `--version` are treated as unknown subcommands (verified live);
   `registry.js`/`version-check.js` are still exposed via the
   convention-dispatched directory (they exit 1 with "does not export a
   default function" rather than crash — a nuance, but still bogus
   subcommands); `uninstall`, `explain`, and `sync-commands` remain
   undocumented consumer-facing (`init` is now documented); `uninstall` is
   still the only mutating command without `--dry-run`; and no subcommand
   rejects unknown flags, so `mandrel update --dryrun` (typo) still performs
   a live install.

## D. Packaging & CI gaps

1. **Tarball:** 7 `__tests__` files still ship in `lib/`
   (verified via `npm pack --dry-run`), and `"main": "index.js"` still
   dangles (no such file).
2. **The Install Matrix still never exercises:** postinstall materialization
   (every leg installs `--ignore-scripts`,
   [install-matrix.yml:218–226](../.github/workflows/install-matrix.yml)),
   the `create-mandrel` cold start (one pure-function unit test), the new
   `mandrel init` path, or running a single materialized script from the
   consumer root — which would immediately expose the pnpm free-ride breakage
   that finding B.2 is masking.
3. **`create-mandrel` still installs floating `latest`** with lifecycle
   scripts enabled ([index.js:68](../create-mandrel/index.js)), then runs the
   sync the postinstall already did. The version-sync pre-commit guard still
   checks only the root manifest entry
   ([check-version-sync.js:42](../scripts/check-version-sync.js)), and the
   launcher's changelog confirms it gets version-bumped by unrelated root
   work (0.2.0 and 0.3.0 both cite root-only commits).
4. **`knip` still never scans `bin/`, `lib/`, or `create-mandrel/`** — the
   entire npm distribution surface remains invisible to the dead-code gate.
5. **Doc nits:** [AGENTS.md](../AGENTS.md) still says "License: ISC" vs MIT
   in both `package.json`s and `LICENSE`; the three-agentrc-files table is
   still maintained in two places
   ([configuration.md:727](../.agents/docs/configuration.md),
   [.agents/README.md:790](../.agents/README.md)) — content has converged but
   dual maintenance persists. (The original "missing-`ai` typo" finding is
   obsolete: the `10bc86e7` rename made unscoped `mandrel` canonical, and the
   remaining `@mandrelai/agents` references are intentional
   migration/history records.)

---

## Prioritized recommendations (updated)

**P0 — finish the front door:**

- Cut a `create-mandrel` release so the (already-wired) `npm-publish-launcher`
  job runs and claims the unscoped name. Verify with
  `npm view create-mandrel version` afterward. Until it ships, the
  `npx create-mandrel` advertising is a dead front door; `mandrel init` is
  the working path.

**P2 — correctness & consistency:**

- Anchor the `runtime-deps` check and the version cache at `process.cwd()`
  (B.2); add prune-or-flag-extras to sync/drift (B.3).
- Fix the `mandrel update` tail (B.1): add `docs/CHANGELOG.md` to the npm
  `files` allowlist (or drop the changelog-surfacing promise), bypass the 24h
  cache on an explicit `update`, and insert `sync-commands` into `STEP_PLAN`
  before the doctor gate.
- Defuse the merge-methods `[y/N]` Enter-through trap (B.4): unify prompt
  polarity, or fold the gate into the up-front consent question.
- Collapse or fully wire the preview/manifest layer; delete the confirmed
  dead code (including all four stale `/agents-bootstrap-project` hints);
  unify the lockfile/version helpers (C.1–C.3).
- TypeScript → truly optional peer; record or lower the engines floor
  (C.4–C.5).
- Dispatcher: subcommand list, `--help`/`--version`, unknown-flag rejection,
  `uninstall --dry-run`; document `uninstall`/`explain`/`sync-commands`
  (C.6).
- Exclude `lib/**/__tests__` from the tarball and fix/remove the dangling
  `main` (D.1); fix the AGENTS.md license line; single-home the agentrc
  table (D.5).

**P3 — CI:**

- One scripts-enabled npm leg asserting postinstall materialization.
- A registry-backed (e.g. verdaccio) cold-start leg covering both
  `create-mandrel` and `mandrel init`.
- Run one materialized script from the consumer dir per leg.
- Extend knip to `bin/`/`lib/`/`create-mandrel/`; extend the version-sync
  guard to both manifest entries.

## UX bottom line (updated)

The guaranteed first-run failures from the original review are gone: the gh
`project`-scope preflight and the doctor `github-token` check no longer
false-block (#3893, `76bea3e8`), bootstrap ends with an offered commit+push of
the wiring (#3899), and the docs describe one canonical path (#3892) with
`mandrel init` as a working one-command entry. The two remaining traps for a
new user are (1) the advertised `npx create-mandrel`, which still fails
because the launcher has never been published, and (2) the `[y/N]`
merge-methods gate, where Enter-through silently disables auto-merge.
