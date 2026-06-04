# Renovate / Dependabot integration

Mandrel ships as the npm package [`@mandrelai/agents`](https://www.npmjs.com/package/@mandrelai/agents), and the `.agents/` working tree is materialized from the installed package by `mandrel sync`. Because the framework is a regular versioned dependency pinned in your lockfile, framework upgrades can ride the **same dependency-update PRs** you already use for every other package — Renovate or Dependabot opens the bump, `mandrel doctor` gates it in CI, and you review and merge it like any other dependency PR.

This guide gives you a drop-in config for **both** bots. Pick whichever your project already runs — you do not need both. Each config:

- **Scopes to `@mandrelai/agents`** so the rules here only govern the framework dependency (your other packages keep their existing update policy).
- **Runs `mandrel doctor` as the CI gate** so a bump only goes green when `.agents/` re-materializes cleanly, the consumer manifest is unpolluted, the slash commands are in sync, and `gh` is authenticated.
- **Respects the versioning model.** Mandrel lives on the **1.x** line and is released by `release-please` with `versioning: always-bump-minor`, so routine releases only advance the **minor** axis. A **major (1.x → 2.0) is a deliberate, manual operator decision** ([AGENTS.md § Major-version policy](../AGENTS.md)) and is the rare, runbook-backed event documented in [`upgrade-major.md`](upgrade-major.md). The bot configs below therefore let minor/patch bumps flow automatically but **always hold a major for manual review**.

> **These are example consumer configs.** They belong in the project that *depends on* `@mandrelai/agents`, not in this repository. (This repository is the framework itself; its own root `renovate.json` governs Mandrel's own dependencies and is unrelated to the consumer examples here.) Copy the block for your bot into your consumer project root. The two configs below are also shipped verbatim as parseable example files at [`examples/renovate.json`](examples/renovate.json) and [`examples/dependabot.yml`](examples/dependabot.yml) so you can copy them straight from disk.

---

## The upgrade contract a bot PR follows

Whichever bot you use, the lifecycle of a Mandrel bump PR is the same:

1. The bot detects a newer `@mandrelai/agents` on npm and opens a PR that bumps the version in `package.json` and the lockfile.
2. CI checks out the PR branch, installs dependencies, and runs `npx mandrel sync` followed by `npx mandrel doctor`.
3. `mandrel sync` re-materializes `./.agents/` from the new package payload; `mandrel doctor` verifies the result and **exits non-zero** if anything is wrong (drift, unmaterialized tree, stale slash commands).
4. A green `doctor` means the upgrade is clean — merge the PR. A red `doctor` means the upgrade needs attention before it lands.

> **The bot never commits your `.agents/` re-materialization.** It only bumps `package.json` + the lockfile. Running `mandrel sync` in CI is a **verification** step (it proves the new payload materializes cleanly); you re-materialize `./.agents/` locally with `mandrel sync` after you merge, or rely on the `postinstall` hook on your next install. Keep the CI checkout's working tree changes out of the merge — the PR's committed diff is the version bump alone.

A **major** bump (1.x → 2.0) is held for manual review by both configs below. When you are ready to adopt it, follow [`upgrade-major.md`](upgrade-major.md) and run `mandrel update --major` locally rather than merging the bot PR blind.

---

## Renovate

Add a `renovate.json` (or a `renovate` key in `package.json`) to your consumer project root. This config isolates `@mandrelai/agents` into its own package rule, auto-merges minor/patch once CI is green, and pins a major for manual review.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "packageRules": [
    {
      "description": "Mandrel framework: auto-merge minor/patch on the 1.x line once doctor passes in CI",
      "matchPackageNames": ["@mandrelai/agents"],
      "matchUpdateTypes": ["minor", "patch"],
      "groupName": "mandrel",
      "automerge": true,
      "automergeType": "pr",
      "platformAutomerge": true
    },
    {
      "description": "Mandrel framework: hold the deliberate 1.x -> 2.0 major for manual review (see docs/upgrade-major.md)",
      "matchPackageNames": ["@mandrelai/agents"],
      "matchUpdateTypes": ["major"],
      "automerge": false,
      "labels": ["mandrel", "major-update"]
    }
  ]
}
```

The `mandrel doctor` gate is enforced by your CI workflow (Renovate respects your branch-protection required checks before `platformAutomerge` merges). Wire it once:

```yaml
# .github/workflows/mandrel-doctor.yml
name: mandrel-doctor
on:
  pull_request:
    paths:
      - "package.json"
      - "package-lock.json"
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx mandrel sync
      - run: npx mandrel doctor
```

With this in place a minor/patch Mandrel bump opens, runs `mandrel doctor`, and — if green — auto-merges; a major bump opens, runs `mandrel doctor`, and waits for you.

---

## Dependabot

Add a `.github/dependabot.yml` to your consumer project root. Dependabot has no per-package auto-merge knob in the config file, so the policy split (auto-merge minor/patch, hold majors) is expressed with `ignore` + a companion auto-merge workflow. The config below limits Dependabot to `@mandrelai/agents` updates for the framework lifecycle (keep your existing entries for the rest of your dependencies):

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    allow:
      - dependency-name: "@mandrelai/agents"
    labels:
      - "mandrel"
      - "dependencies"
    commit-message:
      prefix: "chore"
      include: "scope"
    # Hold the deliberate 1.x -> 2.0 major for manual review (see docs/upgrade-major.md).
    ignore:
      - dependency-name: "@mandrelai/agents"
        update-types: ["version-update:semver-major"]
```

`ignore` with `version-update:semver-major` means Dependabot **never opens a PR for the major** — you adopt 1.x → 2.0 deliberately by running `mandrel update --major` locally per [`upgrade-major.md`](upgrade-major.md). Minor and patch bumps open as normal PRs.

Gate every Mandrel bump on `mandrel doctor` with the same workflow shown in the Renovate section. To auto-merge the green minor/patch PRs, add an auto-merge workflow that fires once required checks pass:

```yaml
# .github/workflows/mandrel-automerge.yml
name: mandrel-automerge
on: pull_request
permissions:
  contents: write
  pull-requests: write
jobs:
  automerge:
    if: ${{ github.actor == 'dependabot[bot]' }}
    runs-on: ubuntu-latest
    steps:
      - uses: dependabot/fetch-metadata@v2
        id: meta
      - name: Enable auto-merge for Mandrel minor/patch
        if: >-
          steps.meta.outputs.dependency-names == '@mandrelai/agents' &&
          (steps.meta.outputs.update-type == 'version-update:semver-minor' ||
           steps.meta.outputs.update-type == 'version-update:semver-patch')
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The `mandrel doctor` workflow is the required check; `--auto` holds the merge until it goes green, so a failing doctor blocks the merge exactly as it does under Renovate.

---

## Verifying the config

Both example configs are plain JSON / YAML and parse without error. After dropping one into your consumer project:

- **Renovate:** run `npx --yes renovate-config-validator renovate.json` (or let the Renovate app validate on its first run and post to the Dependency Dashboard).
- **Dependabot:** push the file; GitHub validates `.github/dependabot.yml` on commit and surfaces parse errors in the repository's **Insights → Dependency graph → Dependabot** tab.
- **The gate:** open a throwaway PR that bumps `@mandrelai/agents` and confirm the `mandrel-doctor` job runs and reports `✅  Ready (N/N checks passed)`.

For the supported OS / Node / package-manager combinations the doctor gate runs against, see [`compatibility-matrix.md`](compatibility-matrix.md).
