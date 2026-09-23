/**
 * Declarative manifest of every mutation bootstrap can perform, filtered into
 * the install ledger and walked by `mandrel uninstall`. Describes intent only;
 * whether a mutation is a no-op is decided by the idempotent `ensure*` steps.
 *
 * @module bootstrap/manifest
 */

import path from 'node:path';

/**
 * Ledger/uninstall grouping key, not an approval gate; every entry carries one.
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

/** @type {ReadonlySet<string>} */
export const PHASE_GROUP_VALUES = Object.freeze(
  new Set(Object.values(PHASE_GROUPS)),
);

/** @type {readonly string[]} */
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
 * @property {string} target  — project-root-relative path or remote resource.
 * @property {string} action
 * @property {string} detail  — one-line operator-facing description.
 * @property {boolean} reversible — false for remote-admin mutations.
 */

/**
 * File targets are POSIX paths so output is platform-identical; the group
 * set honours the same flags the executing pipeline does.
 *
 * @param {object} [ctx]
 * @param {{ owner?: string, repo?: string }} [ctx.answers]
 * @param {boolean} [ctx.skipGithub]
 * @param {boolean} [ctx.withQuality]
 * @returns {MutationManifestEntry[]}
 */
export function buildMutationManifest(ctx = {}) {
  const rel = (...parts) => path.posix.join(...parts);

  const entries = [];

  entries.push(
    {
      phaseGroup: PHASE_GROUPS.IDE_WIRING,
      target: rel('AGENTS.md'),
      action: 'merge',
      detail:
        'Wire the @.agents/instructions.md system-prompt import into AGENTS.md (folding any CLAUDE.md into it) so Claude Code hydrates the framework on cold start.',
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

  // git-init is the most irreversible local mutation; the ledger must record it.
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
    {
      phaseGroup: PHASE_GROUPS.REPO_CONFIG,
      target: rel('.github', 'ISSUE_TEMPLATE'),
      action: 'create',
      detail:
        'Generate the Story/Epic GitHub Issue Forms from the body SSOT so human-filed tickets round-trip through story-body.parse(). Operator-edited forms are preserved.',
      reversible: true,
    },
  );

  if (ctx.withQuality) {
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

  if (!ctx.skipGithub) {
    const repoSlug =
      ctx.answers?.owner && ctx.answers?.repo
        ? `${ctx.answers.owner}/${ctx.answers.repo}`
        : 'the GitHub repository';
    entries.push(
      {
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
