/**
 * bootstrap/manifest — single mutation-manifest source for the
 * consent-first phased install (Story #3521, Feature #3515, Epic #3438).
 *
 * `buildMutationManifest(ctx)` enumerates every mutation the bootstrap
 * pipeline can perform as a flat, declarative array. Each entry carries the
 * five fields the consent-first install screen needs to preview a change
 * before any write lands:
 *
 *   - `phaseGroup` — one of the four independently-approvable groups
 *     (`ide-wiring`, `repo-config`, `github-admin`, `quality-gates`).
 *   - `target`     — the file path or remote resource the mutation touches.
 *   - `action`     — the verb describing the mutation (`create`, `merge`,
 *     `update`, `run`, `configure`).
 *   - `detail`     — a one-line operator-facing description of the change.
 *   - `reversible` — whether the operator can trivially undo the change
 *     (e.g. delete a created file) vs. a remote-admin mutation that is not
 *     a simple local revert.
 *
 * The manifest is the SINGLE source of truth: `applyProjectBootstrap`'s
 * no-write preview is derived from `buildMutationManifest` so the preview
 * the operator approves and the execution that follows enumerate the exact
 * same set of mutations. There is no second, drift-prone list.
 *
 * The manifest describes *intended* mutations deterministically from the
 * project root; it does not read or mutate any file. Whether a given
 * mutation is a no-op on a particular clone (the file already carries the
 * wiring) is decided at execution time by the idempotent `ensure*` steps —
 * the manifest always lists the full surface so the preview is complete.
 *
 * @module bootstrap/manifest
 */

import path from 'node:path';

/**
 * The four independently-approvable phase groups. The consent-first install
 * flow gates each group behind its own opt-in, so every manifest entry MUST
 * carry exactly one of these values.
 *
 * @type {Readonly<{ IDE_WIRING: 'ide-wiring', REPO_CONFIG: 'repo-config',
 *   GITHUB_ADMIN: 'github-admin', QUALITY_GATES: 'quality-gates' }>}
 */
export const PHASE_GROUPS = Object.freeze({
  IDE_WIRING: 'ide-wiring',
  REPO_CONFIG: 'repo-config',
  GITHUB_ADMIN: 'github-admin',
  QUALITY_GATES: 'quality-gates',
});

/**
 * Frozen set of valid `phaseGroup` values, for validation and the
 * acceptance check. Derived from `PHASE_GROUPS` so the two never drift.
 *
 * @type {ReadonlySet<string>}
 */
export const PHASE_GROUP_VALUES = Object.freeze(
  new Set(Object.values(PHASE_GROUPS)),
);

/**
 * The five required fields on every manifest entry. Exported so tests and
 * downstream renderers can assert entry shape without re-declaring the list.
 *
 * @type {readonly string[]}
 */
export const MANIFEST_ENTRY_FIELDS = Object.freeze([
  'phaseGroup',
  'target',
  'action',
  'detail',
  'reversible',
]);

/**
 * @typedef {object} MutationManifestEntry
 * @property {'ide-wiring'|'repo-config'|'github-admin'|'quality-gates'} phaseGroup
 *   — the independently-approvable group this mutation belongs to.
 * @property {string} target  — file path (relative to project root) or a
 *   remote-resource identifier the mutation touches.
 * @property {string} action  — verb describing the mutation.
 * @property {string} detail  — one-line operator-facing description.
 * @property {boolean} reversible — true when the operator can trivially
 *   undo the change locally; false for remote-admin mutations.
 */

/**
 * Build the consent-first mutation manifest for a project root.
 *
 * Returns a flat array of {@link MutationManifestEntry} objects covering
 * every mutation the bootstrap pipeline performs, partitioned across the
 * four {@link PHASE_GROUPS}. File targets are project-root-relative
 * forward-slash POSIX paths so the preview renders identically on every
 * platform; remote targets are scoped to the resolved `owner/repo` slug.
 *
 * The `github-admin` group is omitted when `ctx.skipGithub` is set, and the
 * `quality-gates` group is omitted when `ctx.skipQuality` is set, so the
 * preview reflects the same flags the executing pipeline honours.
 *
 * @param {object} [ctx]
 * @param {{ owner?: string, repo?: string }} [ctx.answers] — scopes the
 *   `github-admin` targets to the `owner/repo` slug.
 * @param {boolean} [ctx.skipGithub] — omit the `github-admin` group.
 * @param {boolean} [ctx.skipQuality] — omit the `quality-gates` group.
 * @returns {MutationManifestEntry[]}
 */
export function buildMutationManifest(ctx = {}) {
  const rel = (...parts) => path.posix.join(...parts);

  const entries = [];

  // --- ide-wiring -------------------------------------------------------
  // Claude Code / IDE integration: the system-prompt import, the
  // UserPromptSubmit sync hook, the generated flat command surface, and the
  // .gitignore entry that keeps the generated tree out of git.
  entries.push(
    {
      phaseGroup: PHASE_GROUPS.IDE_WIRING,
      target: rel('CLAUDE.md'),
      action: 'merge',
      detail:
        'Wire the @.agents/instructions.md system-prompt import so Claude Code hydrates the framework on cold start.',
      reversible: true,
    },
    {
      phaseGroup: PHASE_GROUPS.IDE_WIRING,
      target: rel('.claude', 'settings.json'),
      action: 'merge',
      detail:
        'Add the UserPromptSubmit re-sync hook so the /<command> tree stays current.',
      reversible: true,
    },
    {
      phaseGroup: PHASE_GROUPS.IDE_WIRING,
      target: rel('.claude', 'commands'),
      action: 'run',
      detail:
        'Generate the flat command surface (/<name>) from .agents/workflows/.',
      reversible: true,
    },
    {
      phaseGroup: PHASE_GROUPS.IDE_WIRING,
      target: rel('.gitignore'),
      action: 'merge',
      detail:
        'Ignore .claude/commands/ (generated), .mcp.json + .env (carry secrets), and the per-clone install ledger.',
      reversible: true,
    },
  );

  // --- repo-config ------------------------------------------------------
  // Local repository configuration files the bootstrap seeds or extends.
  // Also includes git-init, which is the most irreversible local mutation
  // the bootstrap performs (B1 — uninstall ledger must record it).
  entries.push(
    {
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
      target: rel('.git'),
      action: 'run',
      detail:
        'Initialize the local git repository (git init + first commit) when absent. No-op when already a git repo.',
      reversible: false,
    },
    {
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
      target: rel('package.json'),
      action: 'merge',
      detail:
        'Seed/merge the sync:commands, prepare, and bootstrap npm scripts.',
      reversible: true,
    },
    {
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
      target: rel('.agentrc.json'),
      action: 'create',
      detail:
        'Seed .agentrc.json from the bundled starter with the operator-supplied owner/repo/handle/base-branch.',
      reversible: true,
    },
  );

  // --- quality-gates ----------------------------------------------------
  // Stabilized quality-gate surface (husky pre-commit, quality npm
  // scripts, .agentrc quality defaults).
  if (!ctx.skipQuality) {
    entries.push(
      {
        phaseGroup: PHASE_GROUPS.QUALITY_GATES,
        target: rel('.husky', 'pre-commit'),
        action: 'configure',
        detail:
          'Install the quality:preview pre-commit hook that blocks MI/CRAP drift at commit time.',
        reversible: true,
      },
      {
        phaseGroup: PHASE_GROUPS.QUALITY_GATES,
        target: rel('package.json'),
        action: 'merge',
        detail: 'Add the quality:preview and quality:watch npm scripts.',
        reversible: true,
      },
      {
        phaseGroup: PHASE_GROUPS.QUALITY_GATES,
        target: rel('.agentrc.json'),
        action: 'merge',
        detail:
          'Seed delivery.quality coding-guardrails and auto-refresh defaults.',
        reversible: true,
      },
    );
  }

  // --- github-admin -----------------------------------------------------
  // Remote GitHub configuration. These are NOT trivially reversible local
  // edits — they mutate remote repo/org admin state.
  if (!ctx.skipGithub) {
    const repoSlug =
      ctx.answers?.owner && ctx.answers?.repo
        ? `${ctx.answers.owner}/${ctx.answers.repo}`
        : 'the GitHub repository';
    entries.push(
      {
        // B1: GitHub repo creation is the most irreversible remote mutation —
        // record it so the uninstall ledger always lists it.
        phaseGroup: PHASE_GROUPS.GITHUB_ADMIN,
        target: `${repoSlug} (repo)`,
        action: 'create',
        detail:
          'Create the GitHub repository (gh repo create --source=. --push) when absent. No-op when already pushed.',
        reversible: false,
      },
      {
        phaseGroup: PHASE_GROUPS.GITHUB_ADMIN,
        target: `${repoSlug} labels`,
        action: 'create',
        detail:
          'Create the framework ticket-lifecycle labels (type::*, agent::*, meta::*, …).',
        reversible: false,
      },
      {
        phaseGroup: PHASE_GROUPS.GITHUB_ADMIN,
        target: `${repoSlug} Projects V2`,
        action: 'configure',
        detail:
          'Create/adopt the Projects V2 board, status field, and saved views.',
        reversible: false,
      },
      {
        phaseGroup: PHASE_GROUPS.GITHUB_ADMIN,
        target: `${repoSlug} branch protection`,
        action: 'configure',
        detail:
          'Apply the required-status-check branch-protection rule to the base branch.',
        reversible: false,
      },
      {
        phaseGroup: PHASE_GROUPS.GITHUB_ADMIN,
        target: `${repoSlug} merge methods`,
        action: 'configure',
        detail:
          'Set the allowed pull-request merge methods to the framework stance (squash-only, auto-merge enabled).',
        reversible: false,
      },
    );
  }

  return entries;
}

/**
 * Render the manifest as a no-write preview report grouped by phase group.
 * Pure helper — derives entirely from {@link buildMutationManifest}, so the
 * preview and the executing pipeline enumerate one identical source.
 *
 * The returned shape is `{ preview: true, groups: { <phaseGroup>: entry[] },
 * entries: entry[] }`: callers that want the flat list read `entries`, and
 * the consent-first screen reads `groups` to render one approvable section
 * per phase group (only groups with at least one entry appear).
 *
 * @param {object} [ctx] — same context as {@link buildMutationManifest}.
 * @returns {{ preview: true, groups: Record<string, MutationManifestEntry[]>,
 *   entries: MutationManifestEntry[] }}
 */
export function previewMutationManifest(ctx = {}) {
  const entries = buildMutationManifest(ctx);
  const groups = {};
  for (const entry of entries) {
    if (!groups[entry.phaseGroup]) groups[entry.phaseGroup] = [];
    groups[entry.phaseGroup].push(entry);
  }
  return { preview: true, groups, entries };
}
