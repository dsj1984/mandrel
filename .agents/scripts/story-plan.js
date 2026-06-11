#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-plan.js — Local `/plan` wrapper.
 *
 * Standalone counterpart to `/plan` for Stories that do **not**
 * attach to an Epic. The script is deliberately a thin CLI around the
 * pure helpers in `lib/story-plan.js`:
 *
 *   1. `--emit-context` mode — given a `--idea`/`--from-notes` seed,
 *      build the context envelope (seed, refine heuristic, persona,
 *      body template, duplicate candidates, tech-stack summary) and
 *      print it as JSON on stdout. Logs route to stderr so the
 *      envelope is byte-clean for `JSON.parse`.
 *   2. Persist mode — given a `--body <file>` authored by the host
 *      LLM after operator confirmation, validate the shape and persist
 *      via `provider.createIssue` (which also adds the new Story to
 *      the configured Projects V2 board — Story #3822) with
 *      `type::story` + the chosen persona label, falling back to
 *      `gh issue create` when the provider lacks a createIssue
 *      analogue. Prints `Next: /single-story-deliver <id>`.
 *   3. `--dry-run` — same as persist but exits without touching
 *      GitHub. Echoes the rendered body and the `gh` argv it would
 *      have run.
 *
 * Mirrors the `/plan` pattern: deterministic Node I/O wrappers
 * with HITL gating handled by the host LLM in chat. No external LLM
 * APIs are called from this script.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { exec as ghExec } from './lib/gh-exec.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';
import {
  buildContextEnvelope,
  loadBodyTemplate,
  rankDuplicateCandidates,
  readTechStackSummary,
  shouldRefine,
  validateStoryBody,
} from './lib/story-plan.js';

const HELP = `\
Usage:
  story-plan.js --emit-context (--idea "<seed>" | --from-notes <file>) \\
    [--persona <name>] [--refine | --no-refine] [--pretty]

  story-plan.js --body <file> [--persona <name>] [--dry-run]

  story-plan.js --help

Modes:
  --emit-context   Build the host-LLM authoring envelope and print it as
                   JSON on stdout. Use this first; the host LLM authors a
                   draft body using the envelope and the body template.
  --body <file>    Persist a pre-authored body. Validates shape (required
                   sections, no Epic: ref, AC checklist non-empty) and
                   calls \`gh issue create\` with type::story + persona.
  --dry-run        With --body: print the body and the gh argv that would
                   be invoked, then exit 0. No GitHub mutations.

Options:
  --persona <name>   Persona label (default: engineer).
  --refine           Force the idea-refinement hint on regardless of seed
                     length. Default heuristic: refine when seed < 200
                     chars.
  --no-refine        Force the idea-refinement hint off.
  --pretty           Pretty-print the JSON envelope.
`;

/**
 * Resolve the seed string from --idea or --from-notes. One of the two
 * must be present in --emit-context mode.
 */
async function resolveSeed({ idea, fromNotes }) {
  if (idea && fromNotes) {
    throw new Error('Pass either --idea or --from-notes, not both.');
  }
  if (idea) return idea;
  if (fromNotes) return (await readFile(fromNotes, 'utf8')).trim();
  throw new Error(
    '--emit-context requires --idea "<seed>" or --from-notes <file>.',
  );
}

/**
 * Fetch open Stories via the ticketing provider. The github provider
 * exposes `listIssuesByLabel({ state, labels })`; other providers may
 * not, so the call is guarded.
 */
async function fetchOpenStories(provider) {
  if (typeof provider.listIssuesByLabel !== 'function') return [];
  const issues = await provider.listIssuesByLabel({
    state: 'open',
    labels: TYPE_LABELS.STORY,
  });
  return issues.map((issue) => ({
    id: issue.number ?? issue.id,
    title: issue.title ?? '',
    body: issue.body ?? '',
    url: issue.html_url ?? issue.url ?? null,
  }));
}

/**
 * Render the draft body argv for `gh issue create`. Returns the argv
 * array; the caller decides whether to execute it (persist) or print
 * it (--dry-run).
 */
function renderGhArgv({ title, bodyPath, labels }) {
  const argv = ['issue', 'create', '--title', title, '--body-file', bodyPath];
  for (const label of labels) {
    argv.push('--label', label);
  }
  return argv;
}

/**
 * Extract the H1 title from a body. Falls back to a sensible default
 * when the body lacks one (host LLM should always emit `# <title>`).
 */
export function extractTitle(body) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : 'Untitled standalone Story';
}

async function runEmitContext({ values, provider, projectRoot }) {
  const seed = await resolveSeed({
    idea: values.idea,
    fromNotes: values['from-notes'],
  });
  const override = values.refine ? 'on' : values['no-refine'] ? 'off' : null;
  const refine = shouldRefine({ seed, override });
  const persona = values.persona ?? 'engineer';

  const [bodyTemplate, openStories, techStack] = await Promise.all([
    loadBodyTemplate(projectRoot),
    fetchOpenStories(provider),
    readTechStackSummary(projectRoot),
  ]);

  const duplicateCandidates = rankDuplicateCandidates({
    seed,
    openStories,
  });

  const envelope = buildContextEnvelope({
    seed,
    refine,
    persona,
    bodyTemplate,
    duplicateCandidates,
    techStack,
  });

  const json = values.pretty
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify(envelope);
  process.stdout.write(`${json}\n`);
}

async function runPersist({
  values,
  provider,
  dryRun,
  // Injectable stdout port so unit tests can capture/silence the summary
  // JSON without stubbing the process-global stream (raw stdout writes
  // corrupt the `node --test` runner's structured report stream).
  write = (s) => process.stdout.write(s),
}) {
  const bodyPath = values.body;
  if (!bodyPath) {
    throw new Error('--body <file> is required in persist mode.');
  }
  const body = await readFile(bodyPath, 'utf8');
  const validation = validateStoryBody(body);
  if (!validation.ok) {
    throw new Error(
      `Drafted body failed validation:\n  - ${validation.errors.join('\n  - ')}`,
    );
  }

  const title = extractTitle(body);
  const persona = values.persona ?? 'engineer';
  const labels = [TYPE_LABELS.STORY, `persona::${persona}`];
  const argv = renderGhArgv({ title, bodyPath, labels });

  if (dryRun) {
    Logger.info('--- DRY RUN ---');
    Logger.info(`Title: ${title}`);
    Logger.info(`Labels: ${labels.join(', ')}`);
    Logger.info(`gh argv: gh ${argv.join(' ')}`);
    Logger.info('--- BODY ---');
    Logger.info(body);
    write(
      `${JSON.stringify({ dryRun: true, title, labels, argv }, null, 2)}\n`,
    );
    return;
  }

  // Persist via the provider when available so I/O stays inside the
  // injected ticketing surface. The GitHub provider's `createIssue`
  // also adds the new Story to the configured Projects V2 board via
  // the shared `addIssueToBoard` helper (Story #3822) — idempotent,
  // non-fatal, no-op when no project number is configured — so board
  // membership never depends on GitHub's "Auto-add to project"
  // built-in workflow. Fall back to `gh issue create` only when the
  // provider doesn't expose a createIssue analogue.
  let issueNumber;
  if (typeof provider.createIssue === 'function') {
    const created = await provider.createIssue({ title, body, labels });
    issueNumber = created.number ?? created.id;
  } else {
    // gh-exec returns { stdout, stderr, code }; parse the issue number
    // from the URL.
    const { stdout } = await ghExec({ args: argv });
    const m = stdout.match(/\/issues\/(\d+)/);
    if (!m) {
      throw new Error(
        `gh issue create did not return an issue URL; stdout was: ${stdout}`,
      );
    }
    issueNumber = Number(m[1]);
  }

  write(`${JSON.stringify({ issueNumber, title, labels }, null, 2)}\n`);
  Logger.info(`Next: /single-story-deliver ${issueNumber}`);
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      'emit-context': { type: 'boolean', default: false },
      idea: { type: 'string' },
      'from-notes': { type: 'string' },
      body: { type: 'string' },
      persona: { type: 'string' },
      refine: { type: 'boolean', default: false },
      'no-refine': { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.refine && values['no-refine']) {
    throw new Error('Pass either --refine or --no-refine, not both.');
  }

  const config = resolveConfig();
  const provider = createProvider(config);
  const projectRoot = PROJECT_ROOT;

  if (values['emit-context']) {
    // Reserve stdout for the JSON envelope so a captured file is
    // unconditionally parseable by `JSON.parse`. Mirrors the contract
    // `epic-plan-spec.js` enforces for its own --emit-context mode.
    routeAllOutputToStderr();
    return runEmitContext({ values, provider, projectRoot });
  }

  return runPersist({
    values,
    provider,
    dryRun: values['dry-run'],
  });
}

runAsCli(import.meta.url, main, { source: 'story-plan' });

// Test surface — exported so unit tests can drive the helpers
// without importing the CLI side.
export { fetchOpenStories, renderGhArgv, runPersist };
