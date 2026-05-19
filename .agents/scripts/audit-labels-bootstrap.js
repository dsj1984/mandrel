/**
 * audit-labels-bootstrap.js — Idempotently create the `audit::<dimension>`
 * label taxonomy in the configured GitHub repo.
 *
 * Run this once per repo before `/audit-to-stories` opens its first
 * Story. Re-runs are safe — existing labels are skipped, only missing
 * ones are created. Story #2583 acceptance criterion #6.
 *
 * The dimension list mirrors the 12 audit-* workflows in
 * `.agents/workflows/`. Adding a new audit-* workflow should also add a
 * corresponding entry below.
 *
 * Delegates to `gh label create` so the script works without any
 * provider plumbing — `gh auth status` is the only prerequisite. Per
 * .agents/rules/orchestration-error-handling.md, the CLI surface throws
 * rather than calling Logger.fatal.
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import process from 'node:process';

import { resolveConfig } from './lib/config-resolver.js';

const DIMENSIONS = Object.freeze([
  { name: 'architecture', color: '6f42c1', description: 'Audit-sourced finding: architectural concerns' },
  { name: 'clean-code', color: '0e8a16', description: 'Audit-sourced finding: clean-code / maintainability' },
  { name: 'dependencies', color: 'd4c5f9', description: 'Audit-sourced finding: dependencies / supply chain' },
  { name: 'devops', color: 'fbca04', description: 'Audit-sourced finding: DevOps / CI / CD' },
  { name: 'lighthouse', color: 'c5def5', description: 'Audit-sourced finding: Lighthouse score regressions' },
  { name: 'performance', color: 'b60205', description: 'Audit-sourced finding: performance / latency' },
  { name: 'privacy', color: 'fef2c0', description: 'Audit-sourced finding: privacy / data handling' },
  { name: 'quality', color: '0052cc', description: 'Audit-sourced finding: test quality / coverage gaps' },
  { name: 'security', color: 'b60205', description: 'Audit-sourced finding: security / OWASP' },
  { name: 'seo', color: 'fbca04', description: 'Audit-sourced finding: SEO / discoverability' },
  { name: 'sre', color: '0052cc', description: 'Audit-sourced finding: SRE / observability / reliability' },
  { name: 'ux-ui', color: 'd4c5f9', description: 'Audit-sourced finding: UX / UI concerns' },
]);

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function labelExists(owner, repo, name) {
  const { code, stdout } = runGh([
    'label', 'list',
    '--repo', `${owner}/${repo}`,
    '--limit', '200',
    '--json', 'name',
  ]);
  if (code !== 0) return false;
  try {
    const list = JSON.parse(stdout);
    return Array.isArray(list) && list.some((l) => l?.name === name);
  } catch (_) {
    return false;
  }
}

function createLabel(owner, repo, { name, color, description }, { force }) {
  const args = [
    'label', 'create', name,
    '--repo', `${owner}/${repo}`,
    '--color', color,
    '--description', description,
  ];
  if (force) args.push('--force');
  const { code, stderr } = runGh(args);
  return { ok: code === 0, stderr: stderr.trim() };
}

export function bootstrapAuditLabels({ owner, repo, force = false, dryRun = false } = {}) {
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error('bootstrapAuditLabels: owner is required');
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error('bootstrapAuditLabels: repo is required');
  }

  const created = [];
  const skipped = [];
  const failed = [];

  for (const dim of DIMENSIONS) {
    const labelName = `audit::${dim.name}`;
    const candidate = { ...dim, name: labelName };

    if (dryRun) {
      created.push(labelName);
      continue;
    }

    if (!force && labelExists(owner, repo, labelName)) {
      skipped.push(labelName);
      continue;
    }

    const result = createLabel(owner, repo, candidate, { force });
    if (result.ok) {
      created.push(labelName);
    } else if (/already exists/i.test(result.stderr)) {
      skipped.push(labelName);
    } else {
      failed.push({ label: labelName, reason: result.stderr });
    }
  }

  return { created, skipped, failed, total: DIMENSIONS.length };
}

export const __testing = { DIMENSIONS };

const SELF = process.argv[1] ?? '';
if (SELF.endsWith('audit-labels-bootstrap.js') || process.env.DEBUG_MAIN) {
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

  const config = resolveConfig();
  const owner = values.owner ?? config?.github?.owner;
  const repo = values.repo ?? config?.github?.repo;

  if (!owner || !repo) {
    throw new Error(
      'audit-labels-bootstrap: --owner and --repo are required (or set them in .agentrc.json under github.{owner,repo}).',
    );
  }

  const result = bootstrapAuditLabels({
    owner,
    repo,
    force: !!values.force,
    dryRun: !!values['dry-run'],
  });

  process.stdout.write(
    `audit-labels-bootstrap: ${result.created.length} created, ${result.skipped.length} skipped, ${result.failed.length} failed (of ${result.total}).\n`,
  );
  if (result.created.length > 0) {
    process.stdout.write(`  created: ${result.created.join(', ')}\n`);
  }
  if (result.skipped.length > 0) {
    process.stdout.write(`  skipped: ${result.skipped.join(', ')}\n`);
  }
  if (result.failed.length > 0) {
    for (const f of result.failed) {
      process.stderr.write(`  FAILED ${f.label}: ${f.reason}\n`);
    }
    process.exit(1);
  }
}
