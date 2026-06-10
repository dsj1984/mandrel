/**
 * tests/story-plan.test.js — Story #2293.
 *
 * Covers the pure helpers behind `/story-plan`:
 *   - rankDuplicateCandidates: Jaccard-overlap ranking + size cap.
 *   - shouldRefine: heuristic + operator override.
 *   - validateStoryBody: required sections, Epic-ref guard, AC checklist.
 *   - buildContextEnvelope: shape contract the host LLM consumes.
 *   - extractTitle: H1 → Issue title round-trip.
 *
 * The CLI side is exercised through a single integration check that
 * shells the script with `--dry-run --body <file>` and asserts:
 *   (a) Exit code 0.
 *   (b) Required envelope fields present.
 *   (c) No `Epic:` reference in the rendered body.
 *   (d) AC checklist non-empty.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGh } from '../.agents/scripts/lib/gh-exec.js';
import { routeAllOutputToStderr } from '../.agents/scripts/lib/Logger.js';
import {
  buildContextEnvelope,
  DEFAULT_REFINE_THRESHOLD,
  REQUIRED_SECTIONS,
  rankDuplicateCandidates,
  shouldRefine,
  validateStoryBody,
} from '../.agents/scripts/lib/story-plan.js';
import { TicketGateway } from '../.agents/scripts/providers/github/tickets.js';
import { extractTitle, runPersist } from '../.agents/scripts/story-plan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT_ROOT, '.agents', 'scripts', 'story-plan.js');

const VALID_BODY = `# Test standalone story

## Context

Some context about the work.

## Acceptance Criteria

- [ ] First criterion
- [ ] Second criterion

## Out of Scope

Things not in scope.

## Notes

Optional notes.
`;

describe('rankDuplicateCandidates', () => {
  it('returns [] when no candidate clears minScore', () => {
    const ranked = rankDuplicateCandidates({
      seed: 'rip out unused task body migrator export',
      openStories: [{ id: 1, title: 'completely unrelated database refactor' }],
    });
    assert.deepEqual(ranked, []);
  });

  it('ranks higher-overlap titles first', () => {
    const ranked = rankDuplicateCandidates({
      seed: 'add /story-plan workflow to author standalone Story drafts',
      openStories: [
        { id: 10, title: 'unrelated', url: 'u1' },
        {
          id: 20,
          title: 'author standalone Story drafts via /story-plan',
          url: 'u2',
        },
        {
          id: 30,
          title: 'standalone Story drafts workflow planning',
          url: 'u3',
        },
      ],
    });
    assert.ok(ranked.length >= 2);
    assert.ok(ranked[0].score >= ranked[1].score);
    assert.equal(ranked[0].id, 20);
  });

  it('caps the result list at maxResults', () => {
    const openStories = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      title: `standalone Story draft helper ${i}`,
    }));
    const ranked = rankDuplicateCandidates({
      seed: 'standalone Story draft helper workflow',
      openStories,
      maxResults: 3,
    });
    assert.equal(ranked.length, 3);
  });

  it('throws on missing seed', () => {
    assert.throws(
      () => rankDuplicateCandidates({ seed: '', openStories: [] }),
      /seed must be a non-empty string/,
    );
  });
});

describe('shouldRefine', () => {
  it('refines when seed is shorter than the threshold', () => {
    const r = shouldRefine({ seed: 'short idea' });
    assert.equal(r.refine, true);
  });

  it('does not refine when seed is long enough', () => {
    const seed = 'x'.repeat(DEFAULT_REFINE_THRESHOLD + 10);
    const r = shouldRefine({ seed });
    assert.equal(r.refine, false);
  });

  it('honours --refine override', () => {
    const seed = 'x'.repeat(DEFAULT_REFINE_THRESHOLD + 10);
    const r = shouldRefine({ seed, override: 'on' });
    assert.equal(r.refine, true);
    assert.equal(r.reason, 'operator-forced-on');
  });

  it('honours --no-refine override', () => {
    const r = shouldRefine({ seed: 'tiny', override: 'off' });
    assert.equal(r.refine, false);
    assert.equal(r.reason, 'operator-forced-off');
  });

  it('refines empty seed', () => {
    const r = shouldRefine({ seed: '   ' });
    assert.equal(r.refine, true);
    assert.equal(r.reason, 'empty-seed');
  });
});

describe('validateStoryBody', () => {
  it('accepts a well-formed body', () => {
    const r = validateStoryBody(VALID_BODY);
    assert.deepEqual(r, { ok: true, errors: [] });
  });

  it('reports every missing required section', () => {
    const r = validateStoryBody('# Title only');
    assert.equal(r.ok, false);
    for (const section of REQUIRED_SECTIONS) {
      assert.ok(
        r.errors.some((e) => e.includes(section)),
        `expected an error referencing "${section}"`,
      );
    }
  });

  it('rejects bodies that contain an Epic: reference', () => {
    const body = VALID_BODY.replace(
      '## Context\n',
      '## Context\n\nEpic: #1234\n',
    );
    const r = validateStoryBody(body);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('Epic: #N')),
      'expected an Epic-ref error',
    );
  });

  it('rejects an AC section with no checklist items', () => {
    const body = VALID_BODY.replace(
      /## Acceptance Criteria[\s\S]*?(?=##\s+Out of Scope)/,
      '## Acceptance Criteria\n\nNothing actionable here.\n\n',
    );
    const r = validateStoryBody(body);
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes('checklist')),
      'expected an AC-checklist error',
    );
  });

  it('rejects empty body', () => {
    const r = validateStoryBody('');
    assert.deepEqual(r, { ok: false, errors: ['body is empty'] });
  });
});

describe('buildContextEnvelope', () => {
  it('emits the canonical shape contract', () => {
    const envelope = buildContextEnvelope({
      seed: 'seed text',
      refine: { refine: true, reason: 'seed-shorter-than-200-chars' },
      persona: 'engineer',
      bodyTemplate: '# {{title}}\n',
      duplicateCandidates: [{ id: 1, title: 't', score: 0.42 }],
      techStack: '## Tech Stack\nNode 22',
    });

    assert.equal(envelope.kind, 'story-plan-context');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.seed, 'seed text');
    assert.equal(envelope.persona, 'engineer');
    assert.deepEqual(envelope.requiredSections, REQUIRED_SECTIONS);
    assert.equal(envelope.duplicateCandidates.candidates.length, 1);
    assert.equal(envelope.techStack, '## Tech Stack\nNode 22');
    assert.equal(
      envelope.deliverContract.workflow,
      '.agents/workflows/helpers/single-story-deliver.md',
    );
    assert.ok(envelope.deliverContract.requiredLabels.includes('type::story'));
    assert.ok(
      envelope.deliverContract.requiredLabels.includes('persona::engineer'),
    );
  });

  it('passes through a null techStack', () => {
    const envelope = buildContextEnvelope({
      seed: 'x',
      refine: { refine: false, reason: 'x' },
      persona: 'engineer',
      bodyTemplate: '',
      duplicateCandidates: [],
    });
    assert.equal(envelope.techStack, null);
  });
});

describe('extractTitle', () => {
  it('returns the first H1', () => {
    assert.equal(extractTitle('# Hello world\n\nbody'), 'Hello world');
  });

  it('falls back to a default when no H1 exists', () => {
    assert.equal(
      extractTitle('## Context\n\nbody'),
      'Untitled standalone Story',
    );
  });
});

describe('story-plan.js CLI: --help', () => {
  it('prints usage and exits 0', () => {
    const r = spawnSync('node', [CLI, '--help'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /story-plan\.js/);
    assert.match(r.stdout, /--emit-context/);
    assert.match(r.stdout, /--body/);
    assert.match(r.stdout, /--dry-run/);
  });
});

describe('story-plan.js CLI: --dry-run --body', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'story-plan-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('prints the gh argv it would have run, never touches GitHub', () => {
    const bodyPath = path.join(tmp, 'draft.md');
    writeFileSync(bodyPath, VALID_BODY);
    const r = spawnSync(
      'node',
      [CLI, '--body', bodyPath, '--dry-run', '--persona', 'engineer'],
      { cwd: PROJECT_ROOT, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // The persist-mode summary lands on stdout as JSON.
    const lines = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const jsonLine = lines.findLast((l) => l.startsWith('{'));
    assert.ok(jsonLine, `expected a trailing JSON line in stdout: ${r.stdout}`);
    const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.title, 'Test standalone story');
    assert.ok(parsed.labels.includes('type::story'));
    assert.ok(parsed.labels.includes('persona::engineer'));
    // The argv shape must match what gh-exec would receive.
    assert.deepEqual(parsed.argv, [
      'issue',
      'create',
      '--title',
      'Test standalone story',
      '--body-file',
      bodyPath,
      '--label',
      'type::story',
      '--label',
      'persona::engineer',
    ]);
  });

  it('rejects a body that carries an Epic: reference', () => {
    const bodyPath = path.join(tmp, 'bad.md');
    writeFileSync(
      bodyPath,
      VALID_BODY.replace('## Context\n', '## Context\n\nEpic: #99\n'),
    );
    const r = spawnSync('node', [CLI, '--body', bodyPath, '--dry-run'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Epic: #N/);
  });
});

/**
 * Story #3822 — /story-plan persist-path board membership regression.
 *
 * Drives `runPersist` with a provider whose `createIssue` is the real
 * `TicketGateway.createIssue` (fake gh facade, recording hooks) and
 * proves the created Story is added to the Projects V2 board via the
 * shared board-add helper with the new issue's `node_id` when a project
 * number is configured, and that the add is skipped cleanly when it is
 * not.
 */
describe('story-plan.js runPersist: Projects V2 board membership (Story #3822)', () => {
  // runPersist logs progress via Logger (stdout by default); route it to
  // stderr so log lines cannot interleave with the runner's report stream.
  routeAllOutputToStderr();

  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'story-plan-board-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeProvider({ projectNumber }) {
    const projectCalls = [];
    const exec = async ({ args, input }) => {
      const method = args[2] ?? 'GET';
      if (method === 'POST') {
        const posted = JSON.parse(input);
        return {
          stdout: JSON.stringify({
            number: 8181,
            id: 81810,
            node_id: 'node_8181',
            html_url: 'https://example/8181',
            title: posted.title,
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '{}', stderr: '', code: 0 };
    };
    const gateway = new TicketGateway({
      gh: createGh(exec),
      owner: 'o',
      repo: 'r',
      hooks: {
        addItemToProject: async (nodeId) => {
          projectCalls.push(nodeId);
        },
        getProjectNumber: () => projectNumber,
      },
    });
    const provider = {
      createIssue: (payload) => gateway.createIssue(payload),
    };
    return { provider, projectCalls };
  }

  it('adds the created Story to the board with its node_id when a project number is set', async () => {
    const bodyPath = path.join(tmp, 'draft.md');
    writeFileSync(bodyPath, VALID_BODY);
    const { provider, projectCalls } = makeProvider({ projectNumber: 1 });
    const summaries = [];

    await runPersist({
      values: { body: bodyPath, persona: 'engineer' },
      provider,
      dryRun: false,
      // Capture the summary JSON via the injectable stdout port so raw
      // writes cannot interleave with the test runner's report stream.
      write: (s) => summaries.push(s),
    });

    assert.deepEqual(projectCalls, ['node_8181']);
    const summary = JSON.parse(summaries.join(''));
    assert.equal(summary.issueNumber, 8181);
  });

  it('skips the board add cleanly when no project number is configured', async () => {
    const bodyPath = path.join(tmp, 'draft.md');
    writeFileSync(bodyPath, VALID_BODY);
    const { provider, projectCalls } = makeProvider({ projectNumber: null });
    const summaries = [];

    await runPersist({
      values: { body: bodyPath, persona: 'engineer' },
      provider,
      dryRun: false,
      write: (s) => summaries.push(s),
    });

    assert.deepEqual(projectCalls, []);
    const summary = JSON.parse(summaries.join(''));
    assert.equal(summary.issueNumber, 8181);
  });
});
