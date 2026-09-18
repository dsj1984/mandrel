/**
 * audit-labels-bootstrap.js — idempotently create the audit label taxonomy via
 * `gh label create` (only `gh auth` needed). The taxonomy is the SSOT that
 * `build-story-body.js` also reads, so the bootstrap cannot fall behind the
 * filer. Throws rather than calling Logger.fatal.
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
 * Flags, then `github.{owner,repo}`; throws unless both resolve.
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
