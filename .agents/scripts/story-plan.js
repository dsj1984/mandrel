#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-plan.js — QA helper for promote round-trips and `--emit-context`
 * envelope emission.
 *
 * Canonical operator planning is `plan-context.js` + `plan-persist.js` (see
 * `.agents/workflows/plan.md`). Use this CLI only for QA promote
 * round-trips (`--body` / `--dry-run`) or test harnesses that need the
 * standalone envelope shape.
 *
 * Operator planning:
 *   node .agents/scripts/plan-context.js --seed "…" | --seed-file <path> | --tickets <ids>
 *   node .agents/scripts/plan-persist.js --stories …
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import { exec as ghExec } from './lib/gh-exec.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { recordPlanInvocation } from './lib/orchestration/plan-metrics.js';
import { buildCorpusContext } from './lib/planning-corpus.js';
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
  story-plan.js --emit-context (--seed "<seed>" | --seed-file <file>) \\
    [--refine | --no-refine] [--pretty]

  story-plan.js --body <file> [--dry-run]

  story-plan.js --help

Modes:
  --emit-context   Build the host-LLM authoring envelope and print it as
                   JSON on stdout. Use this first; the host LLM authors a
                   draft body using the envelope and the body template.
  --body <file>    Persist a pre-authored body. Validates shape (required
                   sections, no Epic: ref, AC checklist non-empty) and
                   calls \`gh issue create\` with type::story.
  --dry-run        With --body: print the body and the gh argv that would
                   be invoked, then exit 0. No GitHub mutations.

Options:
  --refine           Force the idea-refinement hint on regardless of seed
                     length. Default heuristic: refine when seed < 200
                     chars.
  --no-refine        Force the idea-refinement hint off.
  --pretty           Pretty-print the JSON envelope.
`;

/**
 * Resolve the seed string from --seed or --seed-file. One of the two
 * must be present in --emit-context mode.
 */
async function resolveSeed({ seed, seedFile }) {
  if (seed && seedFile) {
    throw new Error('Pass either --seed or --seed-file, not both.');
  }
  if (seed) return seed;
  if (seedFile) return (await readFile(seedFile, 'utf8')).trim();
  throw new Error(
    '--emit-context requires --seed "<seed>" or --seed-file <file>.',
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

async function runEmitContext({
  values,
  provider,
  projectRoot,
  config,
  // Injectable stdout port so unit tests can capture the emitted envelope
  // without stubbing the process-global stream (mirrors the `runPersist`
  // pattern above — raw stdout writes corrupt the `node --test` runner's
  // structured report stream).
  write = (s) => process.stdout.write(s),
}) {
  const seed = await resolveSeed({
    seed: values.seed,
    seedFile: values['seed-file'],
  });
  const override = values.refine ? 'on' : values['no-refine'] ? 'off' : null;
  const refine = shouldRefine({ seed, override });

  // Corpus lookup uses the raw (un-defaulted) docsContextFiles list, same
  // as the `/deliver` per-Epic digest builder: `config.project` fills in
  // the framework's default four-file set even when the operator
  // configured nothing, so a null-vs-configured distinction requires
  // reading `config.raw` directly.
  const docsContextFiles = config?.raw?.project?.docsContextFiles ?? [];
  // Resolve docsRoot against PROJECT_ROOT (not process.cwd()) so the
  // corpus digest reads the project's actual docs directory regardless
  // of the directory this CLI happens to be invoked from — matching the
  // sibling resolution pattern in
  // planning/authoring-context.js.
  const docsRoot = path.resolve(
    PROJECT_ROOT,
    config?.project?.paths?.docsRoot ?? 'docs',
  );

  const [bodyTemplate, openStories, techStack, corpusContext] =
    await Promise.all([
      loadBodyTemplate(projectRoot),
      fetchOpenStories(provider),
      readTechStackSummary(projectRoot),
      buildCorpusContext({ docsContextFiles, docsRoot }),
    ]);

  const duplicateCandidates = rankDuplicateCandidates({
    seed,
    openStories,
  });

  const envelope = buildContextEnvelope({
    seed,
    refine,
    bodyTemplate,
    duplicateCandidates,
    techStack,
    corpusContext,
  });

  const json = values.pretty
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify(envelope);
  write(`${json}\n`);
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
  const labels = [TYPE_LABELS.STORY];
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
  Logger.info(`Next: /deliver ${issueNumber}`);
}

/* node:coverage ignore next */
async function main() {
  const { values } = parseArgs({
    options: {
      'emit-context': { type: 'boolean', default: false },
      seed: { type: 'string' },
      'seed-file': { type: 'string' },
      body: { type: 'string' },
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
    // `plan-context.js` enforces for its emit mode.
    routeAllOutputToStderr();
    // Plan-metrics ledger (#4474 PR1): standalone plans have no Epic, so
    // `epicId: null` routes the stamp to the standalone stream
    // (`temp/standalone/plan-metrics.json`) — same pattern as friction.
    return recordPlanInvocation(
      { cli: 'story-plan', mode: 'emit-context', epicId: null, config },
      () => runEmitContext({ values, provider, projectRoot, config }),
    );
  }

  // Plan-metrics ledger (#4474 PR1): stamp entry/exit + mode.
  return recordPlanInvocation(
    { cli: 'story-plan', mode: 'persist', epicId: null, config },
    () =>
      runPersist({
        values,
        provider,
        dryRun: values['dry-run'],
      }),
  );
}

runAsCli(import.meta.url, main, { source: 'story-plan' });

// Test surface — exported so unit tests can drive the helpers
// without importing the CLI side.
export {
  fetchOpenStories,
  renderGhArgv,
  resolveSeed,
  runEmitContext,
  runPersist,
};
