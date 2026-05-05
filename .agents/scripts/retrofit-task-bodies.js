#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * retrofit-task-bodies.js — one-shot upgrade of in-flight Epic Task bodies
 * to the v5.33 four-section structured schema (`## Goal` / `## Changes` /
 * `## Acceptance` / `## Verify` + orchestrator footer).
 *
 * Two-phase invocation, mirroring the planner / decomposer split:
 *
 *   1. Emit context for tasks needing retrofit:
 *        node .agents/scripts/retrofit-task-bodies.js \
 *          --epic 689 --emit-context [--out temp/retrofit-689.json] [--pretty]
 *
 *      Walks every Task descendant of the Epic, skips ones whose body
 *      already starts with `## Goal\n` (idempotent), and emits a JSON
 *      envelope per non-conforming task containing:
 *        - id, title, current body, parent Story body
 *        - Tech Spec body excerpt (bounded by planning-context budget)
 *        - whether `docs/style-guide.md` exists in the repo
 *
 *      The host LLM consumes this envelope and produces a "bodies file"
 *      (an array of `{ id, body: { goal, changes, acceptance, verify } }`).
 *
 *   2. Apply the authored bodies:
 *        node .agents/scripts/retrofit-task-bodies.js \
 *          --epic 689 --bodies temp/retrofit-689-bodies.json \
 *          [--dry-run | --apply]
 *
 *      `--dry-run` (default): validates each new body, renders the markdown,
 *      prints a unified diff vs. the existing body, and writes a summary
 *      to `temp/retrofit-task-bodies-<epic>.md`. Exits 0.
 *
 *      `--apply`: same but actually writes via `provider.updateTicket`.
 *      Body-only edits — labels, state, and assignments are never touched.
 *
 * Architecture: this script only ever calls the existing provider methods.
 * It does NOT spawn a remote agent or call an external LLM directly — that
 * step is the operator's responsibility, matching the
 * `epic-plan-decompose --emit-context` pattern. Doing the LLM call here
 * would re-introduce the auth-and-spawn surface area v5.6 deliberately
 * pushed out of the orchestrator.
 *
 * Exit codes:
 *   0 — success (or dry-run completed; or no tasks need retrofit).
 *   1 — fatal error: missing Epic, validation failure on authored bodies,
 *       or apply-mode write failure.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { validateTaskBodies } from './lib/orchestration/task-body-validator.js';
import { createProvider } from './lib/provider-factory.js';
import {
  collectNonConformingTasks,
  parseFooterBlockers,
  parseFooterParent,
  unifiedDiff,
} from './lib/retrofit/task-body-retrofit.js';
import {
  composeTaskBody,
  hasStructuredHeader,
} from './lib/templates/task-body-renderer.js';

const PROJECT_ROOT = process.cwd();
const STYLE_GUIDE_PATH = path.join(PROJECT_ROOT, 'docs', 'style-guide.md');
const TECH_SPEC_EXCERPT_BYTES = 4000;

async function styleGuideExists() {
  try {
    await readFile(STYLE_GUIDE_PATH, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the per-task enrichment envelope that the host LLM consumes.
 * Tech Spec body is loaded once and trimmed to TECH_SPEC_EXCERPT_BYTES
 * to keep the envelope under typical context-window budgets.
 */
async function buildEnrichmentContext(epicId, provider) {
  const epic = await provider.getEpic(epicId);
  const techSpecId = epic?.linkedIssues?.techSpec ?? null;
  let techSpecExcerpt = '';
  if (techSpecId) {
    const ts = await provider.getTicket(techSpecId).catch(() => null);
    techSpecExcerpt = (ts?.body ?? '').slice(0, TECH_SPEC_EXCERPT_BYTES);
  }
  const styleGuide = await styleGuideExists();

  const items = await collectNonConformingTasks(epicId, provider);
  return {
    epicId,
    epicTitle: epic?.title ?? null,
    techSpecId,
    techSpecExcerpt,
    styleGuidePresent: styleGuide,
    tasks: items.map(({ task, parentStory }) => {
      return {
        id: task.id,
        title: task.title,
        currentBody: task.body ?? '',
        parentStoryId: parentStory?.id ?? null,
        parentStoryTitle: parentStory?.title ?? null,
        parentStoryBody: parentStory?.body ?? null,
      };
    }),
  };
}

async function runEmitContext(epicId, provider, { out, pretty }) {
  const ctx = await buildEnrichmentContext(epicId, provider);
  const json = pretty ? JSON.stringify(ctx, null, 2) : JSON.stringify(ctx);
  if (out) {
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${json}\n`, 'utf8');
    console.log(
      `[retrofit] Wrote ${ctx.tasks.length} task context(s) to ${out}`,
    );
  } else {
    process.stdout.write(`${json}\n`);
  }
}

/**
 * Apply (or dry-run) the authored bodies against the existing tickets.
 * Bodies are validated against the v5.33 schema before any edit lands.
 */
async function runApply(epicId, provider, { bodiesFile, dryRun }) {
  const raw = await readFile(bodiesFile, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[retrofit] bodies file is not valid JSON: ${err.message}`);
  }
  const bodies = Array.isArray(payload) ? payload : payload.bodies;
  if (!Array.isArray(bodies)) {
    throw new Error(
      '[retrofit] bodies file must be an array of { id, body } or { bodies: [...] }',
    );
  }

  // Validate every body up-front so an apply run never lands a partial
  // result. Synthesise task-shaped objects so we can reuse the validator.
  const synthetic = bodies.map((b) => ({
    slug: `retrofit-${b.id}`,
    type: 'task',
    title: `#${b.id}`,
    parent_slug: 'unknown',
    body: b.body,
  }));
  validateTaskBodies(synthetic);

  const auditSnapshot = new Date().toISOString().slice(0, 10);
  const summaryLines = [
    `# Retrofit task bodies — Epic #${epicId}`,
    `_Snapshot ${auditSnapshot} · mode=${dryRun ? 'dry-run' : 'apply'} · count=${bodies.length}_`,
    '',
  ];

  let applied = 0;
  let skipped = 0;
  for (const entry of bodies) {
    const taskId = entry.id;
    let existing;
    try {
      existing = await provider.getTicket(taskId, { fresh: true });
    } catch (err) {
      throw new Error(
        `[retrofit] Failed to fetch task #${taskId}: ${err.message}`,
      );
    }
    if (hasStructuredHeader(existing.body)) {
      console.log(`[retrofit] SKIP #${taskId} — already four-section format`);
      summaryLines.push(`- #${taskId} — skipped (already conforming)`);
      skipped++;
      continue;
    }

    const parentId = parseFooterParent(existing.body) ?? epicId;
    const dependencies = parseFooterBlockers(existing.body);
    const newBody = composeTaskBody({
      body: entry.body,
      parentId,
      epicId,
      dependencies,
      auditSnapshot,
    });

    const diff = unifiedDiff(existing.body ?? '', newBody, `#${taskId}`);
    summaryLines.push(
      '',
      `## #${taskId} — ${existing.title}`,
      '```diff',
      diff,
      '```',
    );

    if (dryRun) {
      console.log(diff);
      console.log('');
      continue;
    }

    try {
      await provider.updateTicket(taskId, { body: newBody });
      applied++;
      console.log(`[retrofit] Applied #${taskId}`);
    } catch (err) {
      throw new Error(
        `[retrofit] Failed to update task #${taskId}: ${err.message}`,
      );
    }
  }

  const summaryDir = path.join(PROJECT_ROOT, 'temp');
  await mkdir(summaryDir, { recursive: true });
  const summaryPath = path.join(
    summaryDir,
    `retrofit-task-bodies-${epicId}.md`,
  );
  await writeFile(summaryPath, summaryLines.join('\n'), 'utf8');

  console.log('');
  console.log(
    `[retrofit] ${dryRun ? 'DRY-RUN' : 'APPLIED'}: ${applied} updated, ${skipped} skipped, ${bodies.length - applied - skipped} previewed.`,
  );
  console.log(`[retrofit] Summary written to ${summaryPath}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'emit-context': { type: 'boolean', default: false },
      bodies: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      out: { type: 'string' },
      pretty: { type: 'boolean', default: false },
    },
  });

  if (!values.epic) {
    Logger.fatal(
      'Usage: retrofit-task-bodies.js --epic <id> (--emit-context [--out FILE] [--pretty] | --bodies FILE [--dry-run | --apply])',
    );
  }
  const epicId = Number.parseInt(values.epic, 10);
  if (Number.isNaN(epicId)) {
    Logger.fatal(`Invalid epic ID: "${values.epic}"`);
  }

  const config = resolveConfig();
  const provider = createProvider(config.orchestration);

  if (values['emit-context']) {
    await runEmitContext(epicId, provider, {
      out: values.out,
      pretty: values.pretty,
    });
    return;
  }

  if (!values.bodies) {
    Logger.fatal(
      'Missing --bodies <file>. Run with --emit-context first to gather context, then have your LLM author bodies and pass them back via --bodies.',
    );
  }
  if (values.apply && values['dry-run']) {
    Logger.fatal('--apply and --dry-run are mutually exclusive.');
  }
  const dryRun = !values.apply;

  await runApply(epicId, provider, { bodiesFile: values.bodies, dryRun });
}

runAsCli(import.meta.url, main, { source: 'retrofit-task-bodies' });
