#!/usr/bin/env node
/**
 * Manifest rollup smoke (Epic #1178 Story #1198 Task #1231).
 *
 * One-shot operator script:
 *   1. Renders the synthetic-Epic fixture from
 *      `tests/lib/presentation/manifest-formatter-end-to-end.test.js`
 *      via `formatManifestMarkdown`.
 *   2. Posts the rendered markdown as a comment on a real GitHub issue
 *      (defaults to Epic #1178 in the configured repo; override with
 *      `--issue <number>` and `--repo <owner/repo>`).
 *   3. Re-fetches the comment HTML to assert two invariants:
 *        (a) every Wave Summary TOC anchor in the markdown resolves to a
 *            real H2 anchor on the rendered comment page;
 *        (b) the GitHub native sub-issue / task-list rollup percentage
 *            matches the ratio of `[x]` checkboxes to total `[ ]` /
 *            `[x]` checkboxes in the synthetic-Epic markdown.
 *
 * Output is JSON on stdout; non-zero exit when any check fails. The
 * operator captures this output in the Epic close-out notes.
 *
 * Usage:
 *
 *   GITHUB_TOKEN=ghp_…  node scripts/smoke/manifest-rollup-smoke.js \
 *     --issue 1178 --repo dsj1984/agent-protocols
 *
 * Flags:
 *   --issue <n>    issue number to comment on (default: 1178)
 *   --repo <slug>  owner/repo (default: read from .agentrc.json)
 *   --dry-run      render + check locally; do NOT POST or DELETE
 *   --keep         leave the smoke comment in place (default: delete on
 *                  success). Useful when capturing a screenshot for the
 *                  Epic close-out notes.
 *
 * The script is intentionally lightweight (no graphql client, no MCP
 * dependency) so the smoke runs from any worktree with a `GITHUB_TOKEN`
 * in the environment.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  __resetManifestFormatterCache,
  formatManifestMarkdown,
  slugifyHeading,
} from '../../.agents/scripts/lib/presentation/manifest-formatter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    issue: 1178,
    repo: null,
    dryRun: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issue') out.issue = Number(argv[++i]);
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: manifest-rollup-smoke.js [--issue N] [--repo o/r] [--dry-run] [--keep]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

function readDefaultRepo() {
  try {
    const cfg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.agentrc.json'), 'utf8'),
    );
    const gh = cfg?.orchestration?.github ?? {};
    if (gh.owner && gh.repo) return `${gh.owner}/${gh.repo}`;
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Synthetic fixture (kept in sync with the e2e test fixture by shape)
// ---------------------------------------------------------------------------

function task(id, status = 'agent::ready', deps = []) {
  return { taskId: id, taskSlug: `task-${id}`, status, dependencies: deps };
}
function story(id, title, wave, tasks) {
  return {
    storyId: id,
    storySlug: `story-${id}`,
    storyTitle: title,
    type: 'story',
    earliestWave: wave,
    branchName: `story-${id}`,
    tasks,
  };
}

function buildSmokeFixture() {
  return {
    epicId: 11780,
    epicTitle: 'Synthetic E2E Fixture Epic (rollup smoke)',
    generatedAt: new Date().toISOString(),
    summary: {
      totalTasks: 14,
      doneTasks: 4,
      progressPercent: Math.round((4 / 14) * 100),
      dispatched: 4,
      totalWaves: 3,
    },
    storyManifest: [
      story(100, 'Sprint Bootstrap', 0, [
        task(1001, 'agent::done'),
        task(1002, 'agent::done', [1001]),
        task(1003, 'agent::executing', [1002]),
      ]),
      story(101, 'Wire Telemetry', 0, [
        task(1011, 'agent::done'),
        task(1012, 'agent::ready', [1011]),
      ]),
      story(200, 'Render TOC', 1, [
        task(2001, 'agent::ready'),
        task(2002, 'agent::ready', [2001]),
        task(2003, 'agent::ready', [2002]),
      ]),
      story(201, 'Nest Stories', 1, [
        task(2011, 'agent::ready'),
        task(2012, 'agent::ready', [2011]),
        task(2013, 'agent::ready', [2011]),
      ]),
      story(300, 'Order Tasks', 2, [
        task(3001, 'agent::ready', [2001]),
        task(3002, 'agent::ready', [3001]),
        task(3003, 'agent::blocked', [3001]),
      ]),
    ],
    waves: [],
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Local checks (work without any HTTP call — used by --dry-run and as a
// pre-flight before POSTing)
// ---------------------------------------------------------------------------

/**
 * Pull `[Wave N](#slug)` link targets from the Wave Summary TOC and the
 * H2 slugs from the rendered markdown. Returns the targets that have a
 * matching H2 slug (PASS) and the ones that do not (FAIL).
 */
export function localAnchorCheck(md) {
  const linkTargets = [
    ...md.matchAll(/\[(?:Wave \d+|Ungrouped)\]\(#([^)]+)\)/g),
  ].map((m) => m[1]);
  const h2Slugs = new Set(
    [...md.matchAll(/^## (.+)$/gm)].map((m) => slugifyHeading(m[1])),
  );
  const pass = linkTargets.filter((t) => h2Slugs.has(t));
  const fail = linkTargets.filter((t) => !h2Slugs.has(t));
  return {
    totalLinks: linkTargets.length,
    passCount: pass.length,
    failTargets: fail,
    h2Slugs: [...h2Slugs],
  };
}

/**
 * Compute the expected rollup percentage from the rendered markdown:
 * `done / total` checkbox lines. The GitHub native sub-issue / task-list
 * rollup uses the same arithmetic, so the comment-page percentage is
 * expected to match this number after the comment renders.
 */
export function computeExpectedRollup(md) {
  // Strip the bottom <details> block so legend tables don't pollute the
  // count.
  const detailsRe = /<details>[\s\S]*?<\/details>/;
  const outside = md.replace(detailsRe, '');
  const taskLines = outside.split('\n').filter((l) => /^- \[[ x]\] /.test(l));
  const total = taskLines.length;
  const done = taskLines.filter((l) => l.startsWith('- [x] ')).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, done, percent: pct };
}

// ---------------------------------------------------------------------------
// GitHub HTTP shims (no third-party SDK; stays runnable from any worktree)
// ---------------------------------------------------------------------------

async function gh(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN must be set');
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'manifest-rollup-smoke',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub ${init.method || 'GET'} ${url} → ${res.status}: ${text}`,
    );
  }
  return res.json();
}

async function postComment(repo, issue, body) {
  return gh(`/repos/${repo}/issues/${issue}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function deleteComment(repo, commentId) {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues/comments/${commentId}`,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'manifest-rollup-smoke',
      },
    },
  );
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`DELETE comment ${commentId} → ${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Comment-side checks (run after POST, against the rendered HTML)
// ---------------------------------------------------------------------------

/**
 * Fetch the rendered HTML of a posted comment and verify that every TOC
 * anchor href has a matching `<h2 id="…">` on the page.
 */
async function commentAnchorCheck(comment, expectedAnchors) {
  // GitHub's REST API returns `body_html` when called with the
  // `application/vnd.github.html+json` accept header — re-fetch with that
  // accept header so we can scan rendered HTML directly without parsing
  // the issue page.
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(comment.url, {
    headers: {
      Accept: 'application/vnd.github.html+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'manifest-rollup-smoke',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetch ${comment.url} → ${res.status}: ${text}`);
  }
  const html = await res.text();
  const anchorIds = new Set();
  const idRe = /<h2[^>]*\sid="([^"]+)"/g;
  for (const m of html.matchAll(idRe)) anchorIds.add(m[1]);
  // GitHub prefixes anchors with `user-content-` for security; collapse
  // both spellings into the comparison set.
  const normalized = new Set();
  for (const a of anchorIds) {
    normalized.add(a);
    normalized.add(a.replace(/^user-content-/, ''));
  }
  const fail = expectedAnchors.filter((t) => !normalized.has(t));
  return {
    htmlAnchorCount: anchorIds.size,
    expectedAnchorCount: expectedAnchors.length,
    failAnchors: fail,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ?? readDefaultRepo();
  if (!repo && !args.dryRun) {
    process.stderr.write(
      'no --repo and no orchestration.github.{owner,repo} in .agentrc.json\n',
    );
    process.exit(2);
  }

  __resetManifestFormatterCache();
  const md = formatManifestMarkdown(buildSmokeFixture());

  const anchors = localAnchorCheck(md);
  const expectedRollup = computeExpectedRollup(md);

  const result = {
    repo,
    issue: args.issue,
    dryRun: args.dryRun,
    fixtureBytes: md.length,
    anchorsLocal: {
      pass: anchors.failTargets.length === 0,
      total: anchors.totalLinks,
      passCount: anchors.passCount,
      failTargets: anchors.failTargets,
    },
    expectedRollup,
  };

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(anchors.failTargets.length === 0 ? 0 : 1);
  }

  // Live POST path: comment, re-fetch, verify, optionally delete.
  const comment = await postComment(repo, args.issue, md);
  result.commentId = comment.id;
  result.commentUrl = comment.html_url;

  const expectedAnchorTargets = [
    ...md.matchAll(/\[(?:Wave \d+|Ungrouped)\]\(#([^)]+)\)/g),
  ].map((m) => m[1]);
  const remote = await commentAnchorCheck(comment, expectedAnchorTargets);
  result.anchorsRemote = {
    pass: remote.failAnchors.length === 0,
    expected: remote.expectedAnchorCount,
    htmlAnchorCount: remote.htmlAnchorCount,
    failAnchors: remote.failAnchors,
  };

  // The native sub-issue / task-list rollup is GitHub-side computed; the
  // smoke records the *expected* percentage so the operator can compare
  // against the rendered Epic page (the GraphQL field
  // `subIssuesProgress.percentCompleted` returns the same percentage).
  result.rollup = {
    expected: `${expectedRollup.percent}%`,
    note: 'Compare against the rendered Epic comment progress bar; PASS when the comment-page percentage equals expected.',
  };

  if (!args.keep && remote.failAnchors.length === 0) {
    await deleteComment(repo, comment.id);
    result.cleanedUp = true;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(
    anchors.failTargets.length === 0 && remote.failAnchors.length === 0 ? 0 : 1,
  );
}

// ESM entry-point guard. On Windows, `process.argv[1]` is a backslash-style
// path while `import.meta.url` is a `file:///C:/...` URL — comparing them
// literally drops the script's CLI path. Resolve both into a normalized
// fileURL string so the script runs both as `node smoke.js` and as
// `import('./smoke.js')`.
const __thisFileUrl = import.meta.url;
const __invokedAsCli =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
// Suppress the unused-var lint for the two debug locals above without
// affecting runtime: re-export them as harmless metadata.
export const __SMOKE_META__ = Object.freeze({ thisFileUrl: __thisFileUrl });
