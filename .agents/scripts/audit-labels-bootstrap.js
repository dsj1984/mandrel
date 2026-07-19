/**
 * audit-labels-bootstrap.js — Idempotently create the `audit::<lens>`
 * label taxonomy in the configured GitHub repo.
 *
 * Run this once per repo before `/audit-to-stories` opens its first
 * Story. Re-runs are safe — existing labels are skipped, only missing
 * ones are created. Story #2583 acceptance criterion #6.
 *
 * The lens list is the shared SSOT `AUDIT_LENSES`
 * (`lib/audit-to-stories/audit-lenses.js`), one per `/audit-<lens>` workflow
 * under `.agents/workflows/`. Sourcing the list from the same module that
 * `build-story-body.js` derives `audit::<lens>` labels from guarantees the
 * label producer (this bootstrap) and the label deriver (story-body) cannot
 * drift — a finding from `audit-documentation-results.md` derives
 * `audit::documentation`, and this bootstrap creates exactly that label
 * (Story #4195). The per-lens colour/description metadata lives in
 * `LENS_META` below; adding a new `audit-*` workflow means adding its lens to
 * `AUDIT_LENSES` and (optionally) a `LENS_META` entry.
 *
 * Delegates to `gh label create` so the script works without any
 * provider plumbing — `gh auth status` is the only prerequisite. Per
 * .agents/rules/orchestration-error-handling.md, the CLI surface throws
 * rather than calling Logger.fatal.
 */

import process from 'node:process';
import { parseArgs } from 'node:util';

import { AUDIT_LENSES } from './lib/audit-to-stories/audit-lenses.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { gh as defaultGh, GhExecError } from './lib/gh-exec.js';

/**
 * Per-lens label presentation. Keyed by canonical lens name. A lens absent
 * from this map falls back to {@link DEFAULT_LENS_META} so a newly-added
 * `AUDIT_LENSES` entry still gets a label without a hard requirement to
 * register colour/description here first.
 */
const LENS_META = Object.freeze({
  accessibility: {
    color: 'c5def5',
    description: 'Audit-sourced finding: WCAG accessibility conformance',
  },
  architecture: {
    color: '6f42c1',
    description: 'Audit-sourced finding: architectural concerns',
  },
  'clean-code': {
    color: '0e8a16',
    description: 'Audit-sourced finding: clean-code / maintainability',
  },
  dependencies: {
    color: 'd4c5f9',
    description: 'Audit-sourced finding: dependencies / supply chain',
  },
  devops: {
    color: 'fbca04',
    description: 'Audit-sourced finding: DevOps / CI / CD',
  },
  documentation: {
    color: '1d76db',
    description: 'Audit-sourced finding: documentation staleness / gaps',
  },
  navigability: {
    color: 'bfdadc',
    description: 'Audit-sourced finding: route / nav reachability',
  },
  performance: {
    color: 'b60205',
    description: 'Audit-sourced finding: performance / latency',
  },
  privacy: {
    color: 'fef2c0',
    description: 'Audit-sourced finding: privacy / data handling',
  },
  quality: {
    color: '0052cc',
    description: 'Audit-sourced finding: test quality / coverage gaps',
  },
  security: {
    color: 'b60205',
    description: 'Audit-sourced finding: security / OWASP',
  },
  seo: {
    color: 'fbca04',
    description: 'Audit-sourced finding: SEO / discoverability',
  },
  sre: {
    color: '0052cc',
    description: 'Audit-sourced finding: SRE / observability / reliability',
  },
  'ux-ui': {
    color: 'd4c5f9',
    description: 'Audit-sourced finding: UX / UI concerns',
  },
});

const DEFAULT_LENS_META = Object.freeze({
  color: 'ededed',
  description: 'Audit-sourced finding',
});

const DIMENSIONS = Object.freeze(
  AUDIT_LENSES.map((name) => ({
    name,
    ...(LENS_META[name] ?? DEFAULT_LENS_META),
  })),
);

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

  for (const dim of DIMENSIONS) {
    const labelName = `audit::${dim.name}`;
    const candidate = { ...dim, name: labelName };

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

  return { created, skipped, failed, total: DIMENSIONS.length };
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

export const __testing = { DIMENSIONS };

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

runAsCli(import.meta.url, main, { source: 'audit-labels-bootstrap' });
