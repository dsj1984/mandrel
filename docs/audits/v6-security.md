# Security Audit Report — v6.0 Boundary

> Audit snapshot date: 2026-05-12
> Story: #1599 (`/audit-security: fix all High; defer Medium with issues`)
> Epic: #1184
> Tooling: `npm audit --audit-level=high`, repo-wide grep for risky sinks
> (`eval`, `Function`, `shell: true`, `child_process.exec*`,
> hardcoded-secret patterns), GitHub Actions workflow review, secrets
> management review, and webhook signing review.

## Executive Summary

Overall risk posture is **Low**. `mandrel` is an orchestration
CLI / GitHub-integration toolkit — it has **no HTTP server, no database,
no user-facing UI, no auth surface**. The OWASP Top 10 categories that
dominate web-app threat models (Broken Access Control, Cryptographic
Failures of user PII, Server-Side Request Forgery, Injection from
untrusted clients) do not apply to this repository's deployed shape.

The threat model is narrower and concentrated on three vectors:

1. **Supply-chain compromise** of the toolchain or third-party GitHub
   Actions consumed by CI.
2. **Workflow / argument injection** via `${{ … }}` interpolation in CI
   YAML where operator-controlled inputs reach a shell.
3. **Token leakage** of `GITHUB_TOKEN` / `WEBHOOK_SECRET` through logs,
   error envelopes, or committed `.env` files.

`npm audit --audit-level=high` reports **0 vulnerabilities** at this
snapshot (consistent with the v6-dependencies audit). TruffleHog is wired
into CI for secret scanning. The two High findings below close known
gaps in vectors 1 and 2; the Mediums are deferred with tracked
follow-ups.

| Severity | Count | Status                           |
| -------- | ----- | -------------------------------- |
| Critical | 0     | —                                |
| High     | 2     | Fixed (commits cited below)      |
| Medium   | 3     | Deferred with follow-up issues   |
| Low      | 1     | Informational; no action this    |
|          |       | epic                             |

## Detailed Findings

### H1 — Unpinned third-party GitHub Action (`@main` floating ref)

- **Dimension:** Vulnerable & Outdated Components / Supply Chain
- **Severity:** High
- **CWE ID:** CWE-1357 (Reliance on Insufficiently Trustworthy Component)
- **Current State:** `.github/workflows/ci.yml` consumed
  `trufflesecurity/trufflehog@main`. A floating-branch reference means
  every CI run resolves the action's `action.yml` and entrypoint script
  to whatever HEAD is on `trufflesecurity/trufflehog#main` at job start.
  A compromise (account takeover, malicious PR auto-merge upstream, or a
  contributor with merge rights pushing a backdoored commit) would
  immediately execute in the privileged CI environment with read access
  to the repo source and the `GITHUB_TOKEN`. The action runs **before**
  `npm run lint` / `npm run test`, so it sees the full source tree and
  the runner's filesystem.
- **Recommendation & Rationale:** Pin to the latest released tag
  (`@v3.95.3`). Tag pinning still inherits forward-compat fixes when an
  operator deliberately bumps the version, but eliminates the moving-
  target risk. Long-term, `dependabot` can be configured to PR a SHA pin
  when the team adopts strict SHA-pinning across the repo.
- **Fix:** `.github/workflows/ci.yml` step `Secret Scanning (TruffleHog)`
  now reads `uses: trufflesecurity/trufflehog@v3.95.3` and carries an
  inline comment explaining the supply-chain rationale and the bump
  cadence. (Commit on this Story branch — see "Status".)
- **Status:** ✅ Fixed in commit `<story-1599 HEAD>`.

### H2 — GitHub Actions workflow-input shell injection

- **Dimension:** Injection / OS Command
- **Severity:** High
- **CWE ID:** CWE-94 (Improper Control of Generation of Code)
- **Current State:** `.github/workflows/noise-study.yml` interpolated
  `${{ inputs.runs }}`, `${{ inputs.ref }}`, `${{ matrix.os }}`, and
  `${{ steps.stem.outputs.stem }}` directly into `run:` shell scripts.
  The `${{ … }}` expansion happens **before** the shell sees the line,
  so an input value containing `;`, `$()`, or backticks would execute as
  shell metacharacters. The workflow is gated to
  `workflow_dispatch` (maintainer-triggered, no public webhook), so the
  current attack surface is narrow — but the pattern is the canonical
  GitHub Actions injection footgun and would be a Critical if the
  workflow ever gained a `pull_request_target` or `issue_comment` trigger.
- **Recommendation & Rationale:** Quarantine all `${{ inputs.* }}`,
  `${{ matrix.* }}`, and `${{ steps.* }}` expansions into the step's
  `env:` block, then reference them via shell parameter expansion
  (`"$INPUT_RUNS"`). The shell parser sees only the env-var name, so
  shell metacharacters in the value can never escape into the command
  line. This is the GitHub-recommended hardening
  ([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-an-intermediate-environment-variable)).
- **Fix:** `.github/workflows/noise-study.yml` now passes
  `MATRIX_OS`, `INPUT_RUNS`, `STEM`, `MATRIX_OS`, `STEM_DATE` via the
  step `env:` block and references them as `$INPUT_RUNS` / `$STEM` etc.
  inside the `run:` script. The `with:` block of `actions/upload-artifact`
  still uses `${{ … }}` directly — that's safe because `with:` runs in
  the actions runtime, not a shell parser.
- **Status:** ✅ Fixed in commit `<story-1599 HEAD>`.

### M1 — `spawnSync({ shell: true })` in driver scripts (3 sites)

- **Dimension:** Injection (Defense-in-Depth)
- **Severity:** Medium
- **CWE ID:** CWE-78 (OS Command Injection)
- **Current State:** Three scripts pass `shell: true` to
  `child_process.spawnSync`:
  - `.agents/scripts/run-coverage.js:80` — `npx c8 report` with all
    arguments as a literal string array, no operator input.
  - `.agents/scripts/noise-study.js:436–442` — `npm run test:coverage`
    with no operator input.
  - `.agents/scripts/story-execute-prepare.js:212–215` — runs
    `installCmd` (default `npm ci`, overridable via the `--install-cmd`
    CLI flag — operator-controlled, not network-controlled).
  All three are safe **by construction**: the first two are constants;
  the third is gated behind an operator-supplied CLI flag run on the
  operator's own workstation, so it's not a remote-attack vector. But
  the pattern is brittle: a future refactor that lets external input
  flow into any of these `args` would silently re-open the injection
  hole.
- **Recommendation & Rationale:** Convert each call to argv-form
  (`spawnSync('npx', ['c8', 'report', …], { shell: false })`). On
  Windows, use the `.cmd` shim suffix (`npx.cmd`, `npm.cmd`) so the
  argv path works without re-introducing a shell. The change is purely
  defensive; functionality is identical.
- **Status:** ⏸ Deferred — tracked follow-up (see "Deferred Mediums"
  below).

### M2 — `package.json` lifecycle scripts not constrained at install time

- **Dimension:** Vulnerable & Outdated Components / Supply Chain
- **Severity:** Medium
- **CWE ID:** CWE-1357
- **Current State:** CI runs `npm ci --ignore-scripts` (good); local
  developer installs (`npm install` / `npm ci` from the README) do
  **not** pass `--ignore-scripts`, so a transitive dependency's
  `postinstall` hook would execute on every contributor workstation. The
  repo has no `.npmrc` enforcing `ignore-scripts=true` repo-wide.
- **Recommendation & Rationale:** Add `ignore-scripts=true` to a
  committed `.npmrc`. Explicitly allow-list the (zero) packages that
  require a postinstall hook. This raises the bar against a typo-squatted
  or compromised transitive dependency popping a shell on developer
  laptops.
- **Status:** ⏸ Deferred — tracked follow-up.

### M3 — Verbose error messages can leak environment paths in CLI stderr

- **Dimension:** Security Misconfiguration / Information Exposure
- **Severity:** Medium
- **CWE ID:** CWE-209 (Information Exposure Through an Error Message)
- **Current State:** Several scripts construct error strings that embed
  absolute filesystem paths and full command lines (e.g.
  `story-execute-prepare.js:223–225`:
  `\`install command \\\`${installCmd}\\\` failed with status …\``). On
  an operator workstation this is fine; on CI logs (which are public
  for OSS forks) it can leak the runner's directory layout and the
  shape of internal arguments.
- **Recommendation & Rationale:** Add a `--quiet-errors` mode to the
  CLI utility layer (`lib/cli-utils.js`) that redacts absolute paths to
  their repo-relative form before throwing. The current verbosity is
  the right default for local-operator workflows; the change is opt-in
  for CI.
- **Status:** ⏸ Deferred — tracked follow-up.

### L1 — `process.env.GITHUB_TOKEN` is read without explicit scope validation

- **Dimension:** Identification & Authentication Failures (informational)
- **Severity:** Low
- **CWE ID:** CWE-862 (Missing Authorization — informational)
- **Current State:** `providers/github.js:81` and
  `providers/github/projects-v2-graphql.js:32,41` read `GITHUB_TOKEN` /
  `GH_TOKEN` and pass it to `gh` / `@octokit` without verifying scope
  before making writes. If an operator misconfigures their PAT to a
  classic-token with no scopes, the failure is deferred to the first
  API call and surfaces as a generic 403.
- **Recommendation & Rationale:** Informational. A one-time
  `gh auth status` precheck would surface the misconfiguration earlier,
  but the cost (extra round trip on every CLI run) outweighs the
  current pain.
- **Status:** ℹ️ No action this epic.

## Deferred Mediums — Tracked Follow-ups

Per the Story Acceptance Criteria, every deferred Medium must have a
tracked follow-up issue. The follow-ups are filed as standalone GitHub
issues (visible to the team backlog) rather than child Tasks of this
Story so they can be scheduled against future epics independently:

| Finding | Follow-up Issue                                                | Review Date |
| ------- | -------------------------------------------------------------- | ----------- |
| M1      | #1649 — Convert `shell: true` spawn callers to argv form       | 2026-Q3     |
| M2      | #1650 — Commit `.npmrc` with `ignore-scripts=true`             | 2026-Q3     |
| M3      | #1651 — Add `--quiet-errors` redactor to CLI utility layer     | 2026-Q3     |

Each follow-up cites this audit report as its source-of-truth and pins
the specific commit-sha at which the Medium was triaged.

## Defensive Recommendations

The codebase already implements most of the standard defenses. The four
items below are the highest-leverage hardenings if a future epic ever
expands the deployed surface beyond a local CLI:

1. **SHA-pin all third-party GitHub Actions** (not just version-tag-pin)
   once the team adopts a `dependabot.yml`-driven bump cadence. Tag pins
   are vulnerable to tag deletion + re-tag attacks, which a SHA pin
   eliminates entirely.
2. **Enforce `ignore-scripts=true` in a committed `.npmrc`** for
   developer-workstation installs (M2 above). CI already does this.
3. **Require workflow `env:` quarantine for every `${{ inputs.* }}` /
   `${{ matrix.* }}` reference** that flows into a `run:` step. A
   lightweight `actionlint` step in CI would catch regressions
   mechanically; cost is low.
4. **Document the operator threat model** in
   `.agents/rules/security-baseline.md` explicitly: this is a
   local-CLI / CI-only tool, not a hosted service. The baseline
   currently reads as a web-app baseline, which is correct for downstream
   consumers but undersells the actual `mandrel` shape.

## Out of Scope (and Why)

- **Database / SQL injection** — no database; the repo has no
  persistence layer beyond `baselines/*.json` and on-disk caches.
- **Authentication / session management** — no user-facing auth surface.
  GitHub PAT consumption is operator-side.
- **Cryptographic-strength password hashing** — no password storage.
- **HTML / DOM XSS** — no web UI; markdown rendered by GitHub's renderer
  on the issue tracker, which sanitizes inline HTML.
- **CORS / CSP / HSTS** — no HTTP server.

These categories are explicitly documented in the rules baseline for
downstream consumers (`.agents/rules/security-baseline.md`); they don't
apply to `mandrel` itself.
