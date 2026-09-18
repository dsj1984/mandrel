/**
 * audit-labels-bootstrap.js — Idempotently create the audit label taxonomy in
 * the configured GitHub repo.
 *
 * Run this once per repo before `/audit-to-stories` opens its first
 * Story. Re-runs are safe — existing labels are skipped, only missing
 * ones are created. Story #2583 acceptance criterion #6.
 *
 * This CLI is a thin creator over
 * [`lib/audit-to-stories/audit-label-taxonomy.js`](lib/audit-to-stories/audit-label-taxonomy.js),
 * which is the SSOT for **every** label an audit sweep creates or generates:
 * the `audit::<lens>` set (derived from the shared `AUDIT_LENSES` list, one per
 * `/audit-<lens>` workflow) plus the story-axis labels the filer applies. The
 * creator and the generator (`build-story-body.js`) read that one list, so the
 * bootstrap cannot fall behind the filer — the drift that left `risk::high`
 * generated but defined nowhere (Story #4877), and that made `audit::<dimension>`
 * labels mint from free-form prose before Story #4195.
 *
 * Delegates to `gh label create` so the script works without any
 * provider plumbing — `gh auth status` is the only prerequisite. Per
 * docs/contributing/orchestration-error-handling.md, the CLI surface throws
 * rather than calling Logger.fatal.
 */

import process from 'node:process';
import { parseArgs } from 'node:util';

import { AUDIT_LABEL_TAXONOMY } from './lib/audit-to-stories/audit-label-taxonomy.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { gh as defaultGh, GhExecError } from './lib/gh-exec.js';

async function labelExists(gh, owner, repo, name) {
  try {
    const list = await gh.label.list(
      ['--repo', `${owner}/${repo}`, '--limit', '200'],
      ['name'],
    );
    return Array.isArray(list) && list.some((l) => l?.name === name);
  } catch (_) {
    return false;
  }
}

async function createLabel(
  gh,
  owner,
  repo,
  { name, color, description },
  { force },
) {
  const flags = [
    '--repo',
    `${owner}/${repo}`,
    '--color',
    color,
    '--description',
    description,
  ];
  if (force) flags.push('--force');
  try {
    await gh.label.create(name, flags);
    return { ok: true, stderr: '' };
  } catch (err) {
    const stderr =
      err instanceof GhExecError && typeof err.stderr === 'string'
        ? err.stderr.trim()
        : String(err?.message ?? err).trim();
    return { ok: false, stderr };
  }
}

export async function bootstrapAuditLabels({
  owner,
  repo,
  force = false,
  dryRun = false,
  gh = defaultGh,
} = {}) {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error('bootstrapAuditLabels: owner is required');
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error('bootstrapAuditLabels: repo is required');
  }

  const created = [];
  const skipped = [];
  const failed = [];

  for (const candidate of AUDIT_LABEL_TAXONOMY) {
    const labelName = candidate.name;

    if (dryRun) {
      created.push(labelName);
      continue;
    }

    if (!force && (await labelExists(gh, owner, repo, labelName))) {
      skipped.push(labelName);
      continue;
    }

    const result = await createLabel(gh, owner, repo, candidate, { force });
    if (result.ok) {
      created.push(labelName);
    } else if (/already exists/i.test(result.stderr)) {
      skipped.push(labelName);
    } else {
      failed.push({ label: labelName, reason: result.stderr });
    }
  }

  return { created, skipped, failed, total: AUDIT_LABEL_TAXONOMY.length };
}

/**
 * Resolve `{ owner, repo }` from parsed CLI flags, falling back to the
 * `github.{owner,repo}` config keys. Throws when neither source supplies
 * both values. Pulled out of `main` so the resolution + guard is a single
 * testable unit.
 *
 * @param {{ owner?: string, repo?: string }} values
 * @param {{ github?: { owner?: string, repo?: string } }} [config]
 * @returns {{ owner: string, repo: string }}
 */
export function resolveOwnerRepo(values, config) {
  const owner = values.owner ?? config?.github?.owner;
  const repo = values.repo ?? config?.github?.repo;
  if (!owner || !repo) {
    throw new Error(
      'audit-labels-bootstrap: --owner and --repo are required (or set them in .agentrc.json under github.{owner,repo}).',
    );
  }
  return { owner, repo };
}

/**
 * Render the operator-facing summary lines for a bootstrap result. Pure:
 * returns `{ stdout, stderr }` strings rather than writing, so `main` owns
 * the single write site and the formatting stays unit-testable.
 *
 * @param {{ created: string[], skipped: string[], failed: Array<{label: string, reason: string}>, total: number }} result
 * @returns {{ stdout: string, stderr: string }}
 */
export function formatBootstrapReport(result) {
  const lines = [
    `audit-labels-bootstrap: ${result.created.length} created, ${result.skipped.length} skipped, ${result.failed.length} failed (of ${result.total}).`,
  ];
  if (result.created.length > 0) {
    lines.push(`  created: ${result.created.join(', ')}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`  skipped: ${result.skipped.join(', ')}`);
  }
  const stderr = result.failed
    .map((f) => `  FAILED ${f.label}: ${f.reason}`)
    .join('\n');
  return {
    stdout: `${lines.join('\n')}\n`,
    stderr: stderr ? `${stderr}\n` : '',
  };
}

export const __testing = { AUDIT_LABEL_TAXONOMY };

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    strict: false,
  });

  const { owner, repo } = resolveOwnerRepo(values, resolveConfig());

  const result = await bootstrapAuditLabels({
    owner,
    repo,
    force: !!values.force,
    dryRun: !!values['dry-run'],
  });

  const report = formatBootstrapReport(result);
  process.stdout.write(report.stdout);
  if (report.stderr) process.stderr.write(report.stderr);
  if (result.failed.length > 0) {
    throw new Error(`${result.failed.length} label(s) failed to create`);
  }
}

runAsCli(import.meta.url, main, {
  source: 'audit-labels-bootstrap',
  usage: {
    invocation:
      'node .agents/scripts/audit-labels-bootstrap.js [--owner <owner>] [--repo <repo>] [--force] [--dry-run]',
    summary:
      'Create the audit-finding label taxonomy in the target repository. Idempotent.',
    flags: [
      ['--owner <owner>', 'Repository owner (default: github.owner).'],
      ['--repo <repo>', 'Repository name (default: github.repo).'],
      ['--force', 'Update colour/description of labels that already exist.'],
      ['--dry-run', 'Report what would be created; mutate nothing.'],
    ],
  },
});
