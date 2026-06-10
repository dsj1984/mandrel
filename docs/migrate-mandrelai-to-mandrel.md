# Migrating from `@mandrelai/agents` to `mandrel`

The framework npm package was renamed from the scoped
**`@mandrelai/agents`** to the unscoped **`mandrel`**. The new name is live on
npm and is the only package that receives releases going forward; the old
scoped package is frozen at its last published version and
[deprecated](#operator-step--deprecate-the-old-package-out-of-band) with a
pointer back here.

This is a **one-time, manual hop**. If your project still depends on
`@mandrelai/agents`, follow the steps below once and you are on the new name
for good.

## Who needs this

You need this runbook if your project's `package.json` lists
`@mandrelai/agents` as a dependency (or your lockfile pins it). Fresh installs
already use `mandrel` — [the README quickstart](../README.md#quickstart)
installs the new name directly, so a clean clone never touches the old
package.

## Why `mandrel update` does not auto-migrate

[`mandrel update`](../README.md#update) advances the framework to the newest
published version, but it **resolves the package by name**. It probes
`npm view mandrel version`, installs `mandrel@<newest>`, and re-materializes
`./.agents/` from that payload. It has no knowledge of — and never rewrites —
a dependency entry named `@mandrelai/agents`. A consumer still on the old name
would keep pulling `@mandrelai/agents` forever; `mandrel update` would either
operate on a `mandrel` package that isn't installed or silently no-op against
the old one.

Bridging the rename automatically would mean editing your `package.json` and
lockfile to swap one dependency name for another — a mutation `mandrel update`
deliberately does not perform (it leaves even routine version bumps **staged**
for you to review and commit). There are no external consumers of
`@mandrelai/agents`, so no automated bridge was built. The rename is therefore
a deliberate, documented manual hop you make **once** — after this, ordinary
`mandrel update` carries you forward.

## The manual hop

Run these from your consumer project root, on a branch with a clean working
tree so the whole migration lands as one reviewable commit.

### 1. Swap the dependency

```bash
npm rm @mandrelai/agents
npm install mandrel
```

`npm rm` drops the old scoped dependency from `package.json` and the lockfile;
`npm install mandrel` adds the new unscoped package, resolving to the newest
published version (currently `mandrel@1.57.0`). Pin an exact version if your
policy requires it — the install is provenance-signed either way.

> Using pnpm or yarn? Substitute the equivalent remove/add pair —
> `pnpm remove @mandrelai/agents && pnpm add -D mandrel`, or
> `yarn remove @mandrelai/agents && yarn add -D mandrel`.

### 2. Re-materialize `./.agents/`

```bash
npx mandrel sync
```

`mandrel sync` re-materializes `./.agents/` from the freshly installed
`mandrel` payload. The package's `postinstall` hook usually runs this for you,
but run it explicitly so the materialization is unambiguous (and to cover
`--ignore-scripts` / sandboxed-CI installs).

### 3. Verify and commit

```bash
npx mandrel doctor
```

`mandrel doctor` confirms the install is healthy and `./.agents/` is fully
materialized. Then commit the result:

```bash
git add package.json package-lock.json .agents
git commit -m "build(deps): migrate @mandrelai/agents → mandrel"
```

Stage the updated **lockfile** (`package-lock.json`, `pnpm-lock.yaml`, or
`yarn.lock`) **and** any `.agents/` drift the re-sync produced, so the rename
is captured in one commit. That is the whole migration — subsequent upgrades
are plain `mandrel update`.

## Operator step — deprecate the old package (out-of-band)

> **This step is a registry action, not a code change.** It runs against the
> live npm registry with publish credentials (the `NPM_TOKEN` automation
> account or an interactive maintainer login). It does **not** run in CI and
> is **not** performed by any agent or workflow — a maintainer runs it once,
> by hand, from a shell authenticated to npm.

Deprecate the old scoped package so anyone who installs it sees the rename
notice. **Deprecate, never unpublish** — unpublishing is destructive and would
break any lockfile still pinned to an exact `@mandrelai/agents` version, while
deprecation leaves the package installable and merely surfaces a warning on
every install.

```bash
npm deprecate @mandrelai/agents "Renamed to 'mandrel'. Run: npm install mandrel — see https://github.com/dsj1984/mandrel/blob/main/docs/migrate-mandrelai-to-mandrel.md"
```

Passing the bare package name (no `@version` range) applies the deprecation to
**every** published `@mandrelai/agents` version, so consumers on any prior
version see the warning on install.

### Verify the deprecation

```bash
npm view @mandrelai/agents          # the "DEPRECATED" notice appears in the output
npm install @mandrelai/agents       # in a scratch dir: install prints the deprecation warning
```

`npm view` shows the deprecation message at the top of the package summary;
a throwaway `npm install @mandrelai/agents` in an empty directory prints the
warning inline, confirming consumers on the old name are nudged toward
`mandrel`.
