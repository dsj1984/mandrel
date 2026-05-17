/**
 * lib/orchestration/retro-runner.js — In-process Retro module.
 *
 * Story #1155 (Epic #1142, 5.40.0) — extracts the helper-driven
 * `epic-retro` invocation into a callable module so the renamed
 * `epic-deliver-runner.js` can fire Phase E without a separate LLM
 * helper turn. The retro fires before `/epic-deliver`'s finalize step
 * opens the PR — the operator's PR-merge is the final human gate, not
 * the retro itself.
 *
 * Public API:
 *   - `runRetro({ epicId, provider, logger })` → `{ posted, compact, scorecard, body }`.
 *   - `composeRetroBody(input)` (pure, exported for tests).
 *   - `gatherRetroSignals({ epicId, provider })` (exported for tests).
 *
 * Behaviour:
 *   - Reads child Stories' `story-perf-summary` comments to aggregate
 *     `frictionByCategory` totals (Story #1046 unified-summary path).
 *   - Reads child Tasks' label sets to count hotfixes (`status::blocked`)
 *     and HITL pause events (`agent::blocked`).
 *   - Reads the Epic's `parked-follow-ons` structured comment for the
 *     parked + recut counts (with a fallback to per-Story body grep on the
 *     `<!-- recut-of: #N -->` marker).
 *   - Selects the compact (clean-manifest) or full retro shape via
 *     `isCleanManifest`.
 *   - Posts the composed markdown as a `retro` structured comment on the
 *     Epic, terminated with the `retro-complete: <ISO>` HTML marker.
 *   - **Never** routes through `notify.js` — GitHub is the sole retro
 *     archive; the webhook must not see the retro body.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import { runChecks } from '../checks/index.js';
import { assembleState } from '../checks/state.js';
import { epicRetroMirrorPath } from '../config/temp-paths.js';
import { CONTEXT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { isCleanManifest } from './retro-heuristics.js';
import { parseFencedJsonComment } from './structured-comment-parser.js';
import { findStructuredComment, upsertStructuredComment } from './ticketing.js';

const RECUT_BODY_MARKER = /<!--\s*recut-of:\s*#?\d+\s*-->/;

/**
 * Pure: aggregate `frictionByCategory` payloads into a single integer.
 */
function sumFriction(byCategory) {
  if (!byCategory || typeof byCategory !== 'object') return 0;
  let total = 0;
  for (const v of Object.values(byCategory)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) total += v;
  }
  return total;
}

/**
 * Walk every descendant ticket of `epicId` once. Returns the flat list with
 * each ticket's labels + body + state — the consumer derives its own
 * counts from this snapshot. Pure with respect to the provider injection.
 */
async function collectDescendants(provider, epicId) {
  const visited = new Set([epicId]);
  const out = [];
  const queue = [epicId];
  while (queue.length > 0) {
    const id = queue.shift();
    const subs = (await provider.getSubIssues?.(id)) ?? [];
    for (const sub of subs) {
      const subId = Number(sub?.id ?? sub?.number);
      if (!Number.isInteger(subId) || visited.has(subId)) continue;
      visited.add(subId);
      out.push(sub);
      queue.push(subId);
    }
  }
  return out;
}

/**
 * Read raw retro signals from the GitHub graph. Pure with respect to the
 * provider injection — exported so tests can drive the predicate end-to-end
 * with a stub provider.
 *
 * @returns {Promise<{
 *   stories: Array<{ id: number, body?: string, labels?: string[] }>,
 *   tasks:   Array<{ id: number, labels?: string[] }>,
 *   counts:  { friction: number, parked: number, recuts: number, hotfixes: number, hitl: number },
 *   storyPerfSummaries: object[],
 *   epicPerfReport: object|null,
 *   parkedFollowOns: { recuts: object[], parked: object[], present: boolean },
 * }>}
 */
export async function gatherRetroSignals({ epicId, provider }) {
  const descendants = await collectDescendants(provider, epicId);
  const stories = descendants.filter((t) =>
    (t.labels ?? []).includes(TYPE_LABELS.STORY),
  );
  const tasks = descendants.filter((t) =>
    (t.labels ?? []).includes(TYPE_LABELS.TASK),
  );

  // Hotfix count: tasks that ever flipped to status::blocked. The label
  // set on the closed Task is the cheapest signal (history would require
  // event log access).
  const hotfixes = tasks.filter((t) =>
    (t.labels ?? []).includes('status::blocked'),
  ).length;

  // HITL count: distinct descendants that currently or historically carry
  // `agent::blocked`. We can only see "currently" here without an event
  // stream — counts undercount but never overcount.
  const hitl = descendants.filter((t) =>
    (t.labels ?? []).includes('agent::blocked'),
  ).length;

  // Aggregate per-Story `story-perf-summary` payloads for friction totals.
  const storyPerfSummaries = [];
  let frictionFromSummaries = 0;
  for (const story of stories) {
    const comment = await findStructuredComment(
      provider,
      story.id ?? story.number,
      'story-perf-summary',
    );
    const parsed = parseFencedJsonComment(comment);
    if (parsed) {
      storyPerfSummaries.push(parsed);
      frictionFromSummaries += sumFriction(parsed.frictionByCategory);
    }
  }

  // Epic-level perf report (used by the full retro's "Top hotspots").
  const epicPerfComment = await findStructuredComment(
    provider,
    epicId,
    'epic-perf-report',
  );
  const epicPerfReport = parseFencedJsonComment(epicPerfComment);

  // Parked + recut counts: prefer the structured comment; fall back to body
  // grep for the recut marker when the comment is absent.
  const parkedComment = await findStructuredComment(
    provider,
    epicId,
    'parked-follow-ons',
  );
  const parkedParsed = parseFencedJsonComment(parkedComment);
  let parkedFollowOns;
  if (parkedParsed) {
    parkedFollowOns = {
      present: true,
      recuts: Array.isArray(parkedParsed.recuts) ? parkedParsed.recuts : [],
      parked: Array.isArray(parkedParsed.parked) ? parkedParsed.parked : [],
    };
  } else {
    const recutsByBody = stories.filter(
      (s) => typeof s.body === 'string' && RECUT_BODY_MARKER.test(s.body),
    );
    parkedFollowOns = {
      present: false,
      recuts: recutsByBody.map((s) => ({ storyId: s.id ?? s.number })),
      parked: [],
    };
  }

  const counts = {
    friction: frictionFromSummaries,
    parked: parkedFollowOns.parked.length,
    recuts: parkedFollowOns.recuts.length,
    hotfixes,
    hitl,
  };

  return {
    stories,
    tasks,
    counts,
    storyPerfSummaries,
    epicPerfReport,
    parkedFollowOns,
  };
}

/**
 * Pure: compose the retro markdown body. Exported for tests so they can
 * verify the body shape without round-tripping through a stub provider.
 *
 * @param {{
 *   epicId: number,
 *   epicTitle?: string,
 *   counts: { friction: number, parked: number, recuts: number, hotfixes: number, hitl: number },
 *   storyPerfSummaries?: object[],
 *   epicPerfReport?: object|null,
 *   parkedFollowOns?: { recuts: object[], parked: object[] },
 *   tasksTotal?: number,
 *   tasksFirstTry?: number,
 *   timestamp?: string,
 *   forceFull?: boolean,
 * }} input
 * @returns {{ body: string, compact: boolean, scorecard: object }}
 */
export function composeRetroBody(input) {
  const {
    epicId,
    epicTitle = `Epic ${epicId}`,
    counts,
    epicPerfReport = null,
    parkedFollowOns = { recuts: [], parked: [] },
    tasksTotal = 0,
    tasksFirstTry = 0,
    timestamp = new Date().toISOString(),
    forceFull = false,
  } = input;

  const compact = !forceFull && isCleanManifest(counts);
  const heading = `## 🪞 Sprint Retrospective — Epic #${epicId}: ${epicTitle}`;
  const generatedLine = `_Generated ${timestamp}_`;
  const scorecardRows = [
    `| Total Tasks                  | ${tasksTotal} |`,
    `| Tasks Completed First Try    | ${tasksFirstTry} |`,
    `| Tasks Requiring Hotfix       | ${counts.hotfixes} |`,
    `| agent::blocked Events Raised | ${counts.hitl} |`,
    `| Friction Events              | ${counts.friction} |`,
  ];
  const scorecard = {
    totalTasks: tasksTotal,
    tasksFirstTry,
    hotfixes: counts.hotfixes,
    hitl: counts.hitl,
    friction: counts.friction,
    parked: counts.parked,
    recuts: counts.recuts,
  };
  const completeMarker = `<!-- retro-complete: ${timestamp} -->`;

  if (compact) {
    const body = [
      heading,
      '',
      generatedLine,
      '',
      '🟢 Clean sprint — zero friction, zero parked follow-ons, zero recuts, zero hotfixes, zero agent::blocked events.',
      '',
      '### Sprint Scorecard',
      '',
      '| Metric                       | Value |',
      '| ---------------------------- | ----- |',
      ...scorecardRows,
      '',
      '### Session Observations',
      '',
      '_Nothing notable beyond the scorecard._',
      '',
      '### Action Items for Next Epic',
      '',
      '_None._',
      '',
      completeMarker,
    ].join('\n');
    return { body, compact: true, scorecard };
  }

  // Full path — six sections.
  const hotspotLines =
    epicPerfReport &&
    Array.isArray(epicPerfReport.topHotspots) &&
    epicPerfReport.topHotspots.length > 0
      ? epicPerfReport.topHotspots.map(
          (h) =>
            `- \`${h.phase}\` — ${h.occurrences} occurrence(s), avg ratio ${
              typeof h.avgRatio === 'number' ? h.avgRatio.toFixed(2) : 'n/a'
            }`,
        )
      : ['_No epic-perf-report available._'];

  const parkedLines =
    parkedFollowOns.parked.length > 0
      ? parkedFollowOns.parked.map(
          (p) =>
            `- Adopt or close parked follow-on #${p.storyId ?? p.id ?? '?'}`,
        )
      : [];
  const recutLines =
    parkedFollowOns.recuts.length > 0
      ? parkedFollowOns.recuts.map(
          (r) => `- Recut #${r.storyId ?? r.id ?? '?'} attributed to manifest`,
        )
      : [];
  const actionItems = [...parkedLines, ...recutLines];
  const actionItemsBody =
    actionItems.length > 0 ? actionItems.join('\n') : '_None._';

  const body = [
    heading,
    '',
    generatedLine,
    '',
    '### Sprint Scorecard',
    '',
    '| Metric                       | Value |',
    '| ---------------------------- | ----- |',
    ...scorecardRows,
    '',
    '### What Went Well',
    '',
    '_(populate from execution telemetry — extracted retro module emits a placeholder; deeper analysis is the operator follow-up.)_',
    '',
    '### What Could Be Improved',
    '',
    '#### Top hotspots',
    '',
    ...hotspotLines,
    '',
    '### Architectural Debt',
    '',
    '_(no automated detection in v5.40.0 — operator review required.)_',
    '',
    '### Protocol Optimization Recommendations (Self-Healing)',
    '',
    '_(operator follow-up.)_',
    '',
    '### Action Items for Next Epic',
    '',
    actionItemsBody,
    '',
    completeMarker,
  ].join('\n');
  return { body, compact: false, scorecard };
}

/**
 * Story #2252 — best-effort lifecycle emit helper. Wraps `bus.emit` in a
 * try/catch so a misbehaving observability surface never blocks the
 * retro phase. `bus: null` short-circuits to a no-op.
 */
async function emitLifecycleSafe({ bus, event, payload, logger }) {
  if (!bus || typeof bus.emit !== 'function') return;
  try {
    await bus.emit(event, payload);
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] ⚠️ ${event} emit failed (swallowed): ${err?.message ?? err}`,
    );
  }
}

/**
 * Public: compose and post the retro structured comment on the Epic.
 *
 * Story #1290 (Epic #1143) — at /epic-deliver Phase 5, the runner invokes
 * the self-healing checks registry with `scope: 'retro'` and
 * `autoFix: false`. The retro is **read-only by construction**: the
 * registry runner enforces the invariant by throwing if any caller flips
 * `autoFix: true` under `scope: 'retro'`. Findings are appended to the
 * retro body via `appendChecksSection`, which suppresses the section when
 * findings are empty so the compact "🟢 Clean sprint" shape is preserved.
 *
 * Story #2252 — when `opts.bus` is supplied the runner emits
 * `retro.start` immediately on entry and `retro.end` immediately before
 * returning the envelope. On throw the helper emits `retro.end` with
 * `posted: false` before re-throwing so the ledger always carries the
 * closing boundary.
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: { info?: Function, warn?: Function },
 *   forceFull?: boolean,
 *   timestamp?: string,
 *   bus?: object|null,
 *   now?: () => number,
 *   gatherFn?: typeof gatherRetroSignals,
 *   composeFn?: typeof composeRetroBody,
 *   upsertFn?: typeof upsertStructuredComment,
 *   runChecksFn?: typeof runChecks,
 *   assembleStateFn?: typeof assembleState,
 *   cwd?: string,
 * }} opts
 * @returns {Promise<{
 *   posted: boolean,
 *   compact: boolean,
 *   scorecard: object,
 *   body: string,
 *   findings: object[],
 *   commentId?: number,
 * }>}
 */
export async function runRetro(opts = {}) {
  const {
    epicId,
    provider,
    logger,
    forceFull = false,
    timestamp,
    bus = null,
    now = Date.now,
    gatherFn = gatherRetroSignals,
    composeFn = composeRetroBody,
    upsertFn = upsertStructuredComment,
    runChecksFn = runChecks,
    assembleStateFn = assembleState,
    cwd,
    fsImpl = nodeFs,
  } = opts;

  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runRetro: epicId is required (positive integer).');
  }
  if (!provider) {
    throw new TypeError('runRetro: provider is required.');
  }

  logger?.info?.(`[retro-runner] Composing retro for Epic #${epicId}...`);
  const startedAt = typeof now === 'function' ? now() : Date.now();
  await emitLifecycleSafe({
    bus,
    event: 'retro.start',
    payload: { epicId },
    logger,
  });
  let retroPathWritten = null;
  try {
    return await composeAndPostRetro({
      epicId,
      provider,
      logger,
      forceFull,
      timestamp,
      bus,
      now,
      gatherFn,
      composeFn,
      upsertFn,
      runChecksFn,
      assembleStateFn,
      cwd,
      fsImpl,
      startedAt,
      onMirrorWritten: (p) => {
        retroPathWritten = p;
      },
    });
  } catch (err) {
    // Surface the closing boundary even on throw — the ledger must
    // always show a matched start/end pair.
    const endedAt = typeof now === 'function' ? now() : Date.now();
    const payload = {
      epicId,
      posted: false,
      durationMs: Math.max(0, Math.floor(endedAt - startedAt)),
    };
    if (retroPathWritten) payload.retroPath = retroPathWritten;
    await emitLifecycleSafe({
      bus,
      event: 'retro.end',
      payload,
      logger,
    });
    throw err;
  }
}

/**
 * Inner compose-and-post helper. Extracted so `runRetro` can wrap the
 * full body in a try/catch for the `retro.end` boundary emit without
 * cluttering the happy-path read.
 */
async function composeAndPostRetro({
  epicId,
  provider,
  logger,
  forceFull,
  timestamp,
  bus,
  now,
  gatherFn,
  composeFn,
  upsertFn,
  runChecksFn,
  assembleStateFn,
  cwd,
  fsImpl,
  startedAt,
  onMirrorWritten,
}) {
  const signals = await gatherFn({ epicId, provider });

  // Best-effort fetch of the Epic title for the heading.
  let epicTitle;
  try {
    const epic = await provider.getTicket?.(epicId);
    epicTitle = epic?.title;
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] Failed to fetch Epic #${epicId} title (using fallback): ${err?.message ?? err}`,
    );
  }

  // tasksTotal: every Task descendant. tasksFirstTry: tasks that did not
  // require a hotfix. (Conservative undercount when the runtime never
  // flipped status::blocked, but the metric is honest.)
  const tasksTotal = signals.tasks.length;
  const hotfixCount = signals.counts.hotfixes;
  const tasksFirstTry = Math.max(0, tasksTotal - hotfixCount);

  const { body, compact, scorecard } = composeFn({
    epicId,
    epicTitle,
    counts: signals.counts,
    storyPerfSummaries: signals.storyPerfSummaries,
    epicPerfReport: signals.epicPerfReport,
    parkedFollowOns: signals.parkedFollowOns,
    tasksTotal,
    tasksFirstTry,
    timestamp,
    forceFull,
  });

  const findings = await collectRetroFindings({
    runChecksFn,
    assembleStateFn,
    cwd,
    logger,
  });
  const bodyWithChecks = appendChecksSection(body, findings);

  logger?.info?.(
    `[retro-runner] Posting ${compact ? 'compact' : 'full'} retro on Epic #${epicId}${findings.length > 0 ? ` (${findings.length} finding(s))` : ''}...`,
  );
  const result = await upsertFn(provider, epicId, 'retro', bodyWithChecks);

  // Story #2089: also mirror the retro body to the per-Epic temp dir so
  // operators can read it locally without re-fetching from GitHub. GitHub
  // remains SSOT — a write failure logs a warn and does not fail the
  // phase. The path is resolved relative to `cwd` when supplied so that
  // worktree-scoped invocations land under the worktree's temp tree.
  let mirrorAbsPath = null;
  try {
    const rel = epicRetroMirrorPath(epicId);
    const absPath = path.isAbsolute(rel)
      ? rel
      : path.join(cwd ?? process.cwd(), rel);
    fsImpl.mkdirSync(path.dirname(absPath), { recursive: true });
    fsImpl.writeFileSync(absPath, bodyWithChecks, 'utf8');
    mirrorAbsPath = absPath;
    onMirrorWritten?.(absPath);
    logger?.info?.(`[retro-runner] Mirrored retro to ${absPath}`);
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] Failed to write retro mirror (retro.md) for Epic #${epicId} (continuing — GitHub upsert succeeded): ${err?.message ?? err}`,
    );
  }

  // Story #2252 — emit `retro.end` after the upsert + mirror settle so
  // the lifecycle ledger captures the closing boundary with the
  // posted/compact flags AND the resolved mirror path (when present).
  const endedAt = typeof now === 'function' ? now() : Date.now();
  const retroEndPayload = {
    epicId,
    posted: true,
    compact: Boolean(compact),
    durationMs: Math.max(0, Math.floor(endedAt - startedAt)),
  };
  if (mirrorAbsPath) retroEndPayload.retroPath = mirrorAbsPath;
  await emitLifecycleSafe({
    bus,
    event: 'retro.end',
    payload: retroEndPayload,
    logger,
  });

  return {
    posted: true,
    compact,
    scorecard,
    body: bodyWithChecks,
    findings,
    commentId: result?.commentId,
  };
}

/**
 * Story #1290: invoke the self-healing checks registry with scope:'retro'
 * (read-only by construction — `runChecks` throws on autoFix:true under
 * this scope). Failures degrade gracefully to an empty findings list so
 * the retro never blocks on a probe error.
 */
async function collectRetroFindings({
  runChecksFn,
  assembleStateFn,
  cwd,
  logger,
}) {
  try {
    const state = await assembleStateFn({ scope: 'retro', cwd });
    const result = await runChecksFn({
      scope: 'retro',
      autoFix: false,
      state,
    });
    return Array.isArray(result?.findings) ? result.findings : [];
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] runChecks(scope:'retro') failed (continuing with empty findings): ${err?.message ?? err}`,
    );
    return [];
  }
}

/**
 * Pure: append a "Self-Healing Checks" section to the retro body, listing
 * each finding's id, severity, summary, and fixCommand. When `findings` is
 * empty, the body is returned unchanged — this preserves the compact
 * "🟢 Clean sprint" shape under a clean manifest.
 *
 * The section is inserted **before** the `<!-- retro-complete: ... -->`
 * terminating marker so the marker stays at the end of the body (the
 * deliver pipeline searches for it as the EOF sentinel).
 *
 * Output format mirrors `/diagnose`'s renderTable for fixCommand display:
 * the same literal shell command appears verbatim in a fenced code block
 * so operators can copy-paste it.
 *
 * @param {string} body
 * @param {Array<import('../checks/index.js').Finding>} findings
 * @returns {string}
 */
export function appendChecksSection(body, findings) {
  if (!Array.isArray(findings) || findings.length === 0) return body;
  const section = renderFindingsSection(findings);
  const markerRe = /(<!--\s*retro-complete:[^>]*-->\s*)$/;
  if (markerRe.test(body)) {
    return body.replace(markerRe, `${section}\n$1`);
  }
  return `${body}\n${section}`;
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}

function renderFindingRow(f) {
  const id = escapeCell(f?.id);
  const severity = escapeCell(f?.severity);
  const summary = escapeCell(f?.summary);
  const fixCommand = escapeCell(f?.fixCommand);
  return `| ${id} | ${severity} | ${summary} | \`${fixCommand}\` |`;
}

function renderFindingsSection(findings) {
  return [
    '### Self-Healing Checks',
    '',
    '| ID | Severity | Summary | Fix Command |',
    '| --- | --- | --- | --- |',
    ...findings.map(renderFindingRow),
    '',
  ].join('\n');
}

// Re-export for downstream test convenience — keeps the module's public
// surface explicit so the deliver runner has a single import target.
export { isCleanManifest };

// Sanity import so unused-import warnings don't fire in environments where
// only the constants are used by tests via re-export.
export const __INTERNAL_LABEL_REFERENCES = Object.freeze({
  contextLabels: CONTEXT_LABELS,
});
