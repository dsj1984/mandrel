#!/usr/bin/env node
/**
 * acceptance-spec-reconciler.js — Story #2106 / Task #2113 (Epic #2001).
 *
 * Diffs the AC IDs declared in the Epic body's `## Acceptance Table`
 * managed section (Story #4324 retired the `context::acceptance-spec`
 * ticket class — the table now lives on the Epic body itself) against the
 * **per-Epic-namespaced** `@epic-<id>-ac-*` / `@pending` tags emitted by
 * scenarios under `tests/features/**`. The namespace is load-bearing
 * (Story #3362): `tests/features` is a single global tree shared by every
 * Epic, so a bare `@ac-N` tag authored under an unrelated Epic's scenarios
 * must not count as coverage for this Epic. Surfaces three categories:
 *
 *   - `satisfied[]` — AC IDs covered by at least one non-pending scenario.
 *   - `pending[]`   — AC IDs covered only by scenarios tagged `@pending`.
 *   - `missing[]`   — AC IDs declared in the spec with no matching scenario.
 *
 * Used by `epic-deliver-finalize.js` (Task #2111) as a close-time gate: a
 * non-OK result aborts finalize before the PR opens, so the Epic stays
 * blocked until the AC coverage gap is fixed.
 *
 * Per `.agents/rules/orchestration-error-handling.md`, this module
 * **throws `Error`** for unrecoverable conditions (rather than calling
 * `Logger.fatal`) so the `runAsCli` boundary maps the throw to
 * `process.exit(1)` with the message intact, and so an in-process caller
 * (the finalize orchestrator) can catch and propagate it.
 *
 * Usage:
 *   node .agents/scripts/acceptance-spec-reconciler.js --epic <epicId>
 *
 * When invoked with `writeDispositions: true` (the close-time lifecycle
 * listener path), the reconciler records the verification outcome of each
 * AC row — `satisfied` / `pending` / `missing` — into the Disposition
 * column of the `## Acceptance Table` section. The write is
 * **section-scoped**: only the managed acceptance-table region of the Epic
 * body is rewritten; everything outside it is byte-preserved (Story #4324
 * guardrail, extending the single-writer discipline of #4303).
 *
 * Stdout: a single JSON envelope:
 *   {
 *     "epicId": <number>,
 *     "ok": <boolean>,
 *     "status": "ok"|"waived"|"empty-spec"|"gap",
 *     "acIds": ["AC-1", "AC-2", ...],
 *     "satisfied": ["AC-1", ...],
 *     "pending":   ["AC-2", ...],
 *     "missing":   ["AC-3", ...],
 *     "featureFilesScanned": <number>,
 *     "dispositionsUpdated": <boolean>
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { PENDING_TAGS } from './lib/bdd-runner-detect.js';
import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import {
  extractEpicSection,
  upsertEpicSection,
} from './lib/epic-body-sections.js';
import { Logger } from './lib/Logger.js';
import { ACCEPTANCE_NA } from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/acceptance-spec-reconciler.js --epic <epicId>

Diffs the AC IDs in the Epic body's ## Acceptance Table section against the
@epic-<id>-ac-*/@pending tags in tests/features/**. Emits a JSON envelope on
stdout. Throws (exit 1) when missing or pending ACs are detected, or when
the Epic body has no acceptance-table section and the acceptance::n-a
waiver label is absent.

Options:
  --epic <id>            Epic ticket id (required)
  --features-dir <path>  Override features directory (default: tests/features)
  --skip-when-waived     Exit 0 with status='waived' when acceptance::n-a is
                         set instead of throwing on the missing section.
  --write-dispositions   Record each AC's verification outcome into the
                         Disposition column of the ## Acceptance Table
                         section (section-scoped write).
  -h, --help             Show this message and exit.
`;

/**
 * Pure: parse stable AC IDs (AC-<n>) out of an acceptance-table section.
 * AC authoring style is "Acceptance Table — Markdown table whose first
 * column is the AC ID" — see ACCEPTANCE_SPEC_SYSTEM_PROMPT in
 * epic-plan-spec.js. We scan the entire section with a permissive regex
 * because operators are free to format the content however they wish
 * around the canonical table.
 *
 * Returns IDs **in document order**, deduplicated, normalised to
 * upper-case (`AC-7`, not `ac-7`).
 *
 * @param {string} body
 * @returns {string[]}
 */
export function parseAcIds(body) {
  if (typeof body !== 'string' || body === '') return [];
  const seen = new Set();
  const out = [];
  // \b ensures we don't grab `BAC-7`; the AC- prefix may appear inside a
  // table cell, header, or prose so we don't anchor to ^ or |.
  const re = /\bAC-(\d+)\b/gi;
  let match = re.exec(body);
  while (match !== null) {
    const id = `AC-${match[1]}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
    match = re.exec(body);
  }
  return out;
}

/**
 * Pure: tokenize a single Gherkin scenario block into the set of tag
 * tokens that apply to it. Caller is responsible for slicing the block —
 * `collectScenarioTagSets` below handles that.
 *
 * Tags in Gherkin live on lines preceding `Scenario:` / `Scenario Outline:`
 * and start with `@`. Multiple tags can appear on one line, space-
 * separated.
 *
 * @param {string} tagBlock raw text containing only the tag lines
 * @returns {Set<string>} lowercased tag tokens (without the @ prefix)
 */
function parseTagBlock(tagBlock) {
  const tags = new Set();
  for (const line of tagBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('@')) continue;
    for (const token of trimmed.split(/\s+/)) {
      if (token.startsWith('@') && token.length > 1) {
        tags.add(token.slice(1).toLowerCase());
      }
    }
  }
  return tags;
}

/**
 * Pure: walk a feature-file body and return one tag-set per scenario.
 * Feature-level tags (those above `Feature:`) are inherited by every
 * scenario in the file, matching cucumber/playwright-bdd semantics.
 *
 * @param {string} content
 * @returns {Set<string>[]} one set of lower-cased tag tokens per scenario.
 */
export function collectScenarioTagSets(content) {
  if (typeof content !== 'string' || content === '') return [];
  const lines = content.split(/\r?\n/);
  let featureTags = new Set();
  let featureSeen = false;
  let pendingTagBlock = [];
  const scenarioSets = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      // Blank line breaks a tag block (so a stray @tag far from anything
      // doesn't attach to a later scenario). Discard accumulated tags.
      pendingTagBlock = [];
      continue;
    }
    if (trimmed.startsWith('#')) {
      // Comment line — Gherkin comments are line-level only.
      continue;
    }
    if (trimmed.startsWith('@')) {
      pendingTagBlock.push(trimmed);
      continue;
    }
    if (/^Feature\s*:/i.test(trimmed)) {
      featureTags = parseTagBlock(pendingTagBlock.join('\n'));
      featureSeen = true;
      pendingTagBlock = [];
      continue;
    }
    if (/^(Scenario|Scenario Outline|Example|Rule)\s*:/i.test(trimmed)) {
      // Rule blocks can also carry tags; treat them like scenarios for
      // tag-coverage purposes — they still emit @ac-N when the operator
      // wants to mark the whole rule.
      const scenarioTags = parseTagBlock(pendingTagBlock.join('\n'));
      const merged = new Set(scenarioTags);
      if (featureSeen) for (const t of featureTags) merged.add(t);
      scenarioSets.push(merged);
      pendingTagBlock = [];
      continue;
    }
    // Any other keyword line (Given/When/Then/And/Background) — clear
    // the pending tag block so it doesn't bleed across keywords. Tag
    // blocks only attach to the next Feature/Scenario/Rule.
    pendingTagBlock = [];
  }
  return scenarioSets;
}

/**
 * Recursively enumerate `.feature` files under `dir`. Returns absolute
 * paths. Missing directory is not an error — it returns [] so an Epic that
 * has not yet authored any features hits the "all missing" branch cleanly.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function enumerateFeatureFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.feature')) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * Pure: derive the scenario tag token that satisfies an AC ID for a given
 * Epic. When `epicId` is supplied the token is **namespaced per Epic** —
 * `epic-<id>-ac-<n>` — so a bare `@ac-N` tag authored under an *unrelated*
 * Epic's feature scenarios can never count as coverage for this Epic
 * (Story #3362). When `epicId` is absent the legacy bare `ac-<n>` token is
 * used so non-Epic callers keep their behaviour.
 *
 * @param {string} acId  e.g. `AC-7`
 * @param {number|null} [epicId]
 * @returns {string} lower-cased tag token (no `@` prefix)
 */
export function acTagToken(acId, epicId = null) {
  const bare = acId.toLowerCase(); // e.g. "ac-7"
  if (Number.isInteger(epicId) && epicId > 0) {
    return `epic-${epicId}-${bare}`; // e.g. "epic-1241-ac-7"
  }
  return bare;
}

/**
 * Pure: classify each declared AC ID against the union of scenario tag
 * sets observed across every feature file.
 *
 * Coverage rule (with `epicId`, the matched token is the per-Epic
 * namespaced `epic-<id>-ac-<n>` — see {@link acTagToken}):
 *   - matched token present on at least one scenario with no `pending` tag
 *     on the same scenario → satisfied.
 *   - matched token present only on scenarios that *also* carry `pending`
 *     → pending.
 *   - matched token absent from every scenario → missing.
 *
 * @param {{ acIds: string[], tagSets: Set<string>[], epicId?: number|null }} args
 * @returns {{ satisfied: string[], pending: string[], missing: string[] }}
 */
export function classifyCoverage({ acIds, tagSets, epicId = null }) {
  const satisfied = [];
  const pending = [];
  const missing = [];
  for (const acId of acIds) {
    const tagToken = acTagToken(acId, epicId);
    let sawSatisfied = false;
    let sawPending = false;
    for (const set of tagSets) {
      if (!set.has(tagToken)) continue;
      if ([...set].some((t) => PENDING_TAGS.has(t))) {
        sawPending = true;
      } else {
        sawSatisfied = true;
        break; // a single non-pending scenario satisfies the AC
      }
    }
    if (sawSatisfied) {
      satisfied.push(acId);
    } else if (sawPending) {
      pending.push(acId);
    } else {
      missing.push(acId);
    }
  }
  return { satisfied, pending, missing };
}

/**
 * Pure: render the operator-visible blocker message for a non-OK
 * reconciliation result. Exported so finalize can surface the same text.
 */
export function renderBlockerMessage({ epicId, missing, pending }) {
  const lines = [
    `[acceptance-spec-reconciler] Epic #${epicId} cannot finalize:`,
    `the Epic body's ## Acceptance Table section has uncovered AC IDs.`,
  ];
  if (missing.length > 0) {
    lines.push(
      `  Missing (no @epic-${epicId}-ac-* tag in tests/features): ${missing.join(', ')}`,
    );
  }
  if (pending.length > 0) {
    lines.push(`  Pending (@pending-only coverage): ${pending.join(', ')}`);
  }
  lines.push(
    `Author or de-pend scenarios under tests/features/** tagged @epic-${epicId}-ac-<n> so every AC ID is satisfied, then re-run /deliver.`,
  );
  return lines.join('\n');
}

/**
 * Pure: rewrite the Disposition column of the acceptance-table section so
 * each AC row records its close-time verification outcome. Only table rows
 * whose first data cell is an `AC-<n>` id are touched; header/divider rows,
 * prose, and rows for unclassified ACs pass through verbatim.
 *
 * @param {string} sectionContent The `## Acceptance Table` section content.
 * @param {{ satisfied: string[], pending: string[], missing: string[] }} classification
 * @returns {string}
 */
export function renderDispositions(sectionContent, classification) {
  const outcomeById = new Map();
  for (const id of classification.satisfied ?? []) {
    outcomeById.set(id.toUpperCase(), 'satisfied');
  }
  for (const id of classification.pending ?? []) {
    outcomeById.set(id.toUpperCase(), 'pending');
  }
  for (const id of classification.missing ?? []) {
    outcomeById.set(id.toUpperCase(), 'missing');
  }
  const lines = String(sectionContent ?? '').split('\n');
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) return line;
    const cells = trimmed.split('|');
    // `| a | b |` splits into ['', ' a ', ' b ', ''] — data cells are 1..-2.
    if (cells.length < 4) return line;
    const idMatch = cells[1].trim().match(/^AC-(\d+)$/i);
    if (!idMatch) return line;
    const outcome = outcomeById.get(`AC-${idMatch[1]}`.toUpperCase());
    if (!outcome) return line;
    cells[cells.length - 2] = ` ${outcome} `;
    return cells.join('|');
  });
  return out.join('\n');
}

/**
 * End-to-end reconcile. DI-friendly for tests.
 *
 * Behaviour:
 *   - If the Epic carries the `acceptance::n-a` waiver label, returns
 *     `{ ok: true, status: 'waived', ... }` without scanning features.
 *   - If the Epic body has no `## Acceptance Table` managed section and
 *     the waiver is absent, **throws** a clear `Error` — this should never
 *     happen in practice because `/deliver` runs after `runSnapshotPhase`'s
 *     start gate, but we defend against direct CLI invocation.
 *   - If the acceptance-table section declares zero AC IDs, returns
 *     `{ ok: true, status: 'empty-spec', ... }`.
 *   - Otherwise classifies coverage and returns `{ ok, status, ... }`.
 *     With `writeDispositions: true`, the classification is also recorded
 *     into the Disposition column of the acceptance-table section — a
 *     section-scoped write that preserves every byte outside the managed
 *     region (best-effort: a write failure downgrades to a warning and
 *     never changes the verdict).
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   featuresDir?: string,
 *   skipWhenWaived?: boolean,
 *   writeDispositions?: boolean,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   loggerImpl?: { info?: Function, warn?: Function, error?: Function },
 *   readFeatureFile?: (path: string) => string,
 *   listFeatureFiles?: (dir: string) => string[],
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   status: 'ok'|'waived'|'empty-spec'|'gap',
 *   ok: boolean,
 *   acIds: string[],
 *   satisfied: string[],
 *   pending: string[],
 *   missing: string[],
 *   featureFilesScanned: number,
 *   dispositionsUpdated: boolean,
 * }>}
 */
export async function reconcileAcceptanceSpec({
  epicId,
  cwd,
  featuresDir,
  skipWhenWaived = false,
  writeDispositions = false,
  injectedProvider,
  injectedConfig,
  loggerImpl,
  readFeatureFile = (p) => fs.readFileSync(p, 'utf8'),
  listFeatureFiles = enumerateFeatureFiles,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'reconcileAcceptanceSpec: --epic must be a positive integer',
    );
  }
  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config);
  const logger = loggerImpl ?? Logger;
  const repoCwd = cwd ?? PROJECT_ROOT;
  const dir = featuresDir
    ? path.resolve(repoCwd, featuresDir)
    : path.resolve(repoCwd, 'tests', 'features');

  // 1. Load the Epic. `getEpic` is preferred; fall back to `getTicket`
  //    for providers that don't expose the Epic-shaped reader (test
  //    doubles, primarily). Only `body` and `labels` are consumed.
  let epic;
  if (typeof provider.getEpic === 'function') {
    epic = await provider.getEpic(epicId);
  } else if (typeof provider.getTicket === 'function') {
    epic = await provider.getTicket(epicId);
  }
  if (!epic) {
    throw new Error(`[acceptance-spec-reconciler] Epic #${epicId} not found.`);
  }

  const labels = epic.labels ?? [];
  if (labels.includes(ACCEPTANCE_NA)) {
    logger.info?.(
      `[acceptance-spec-reconciler] Epic #${epicId} carries acceptance::n-a — skipping reconciliation.`,
    );
    return {
      epicId,
      status: 'waived',
      ok: true,
      acIds: [],
      satisfied: [],
      pending: [],
      missing: [],
      featureFilesScanned: 0,
      dispositionsUpdated: false,
    };
  }

  const acceptanceSection = extractEpicSection(
    epic.body ?? '',
    'acceptanceTable',
  );

  if (acceptanceSection === null) {
    if (skipWhenWaived) {
      logger.info?.(
        `[acceptance-spec-reconciler] Epic #${epicId} body has no ## Acceptance Table section; --skip-when-waived set, returning status='waived'.`,
      );
      return {
        epicId,
        status: 'waived',
        ok: true,
        acIds: [],
        satisfied: [],
        pending: [],
        missing: [],
        featureFilesScanned: 0,
        dispositionsUpdated: false,
      };
    }
    // Defence in depth — the start gate would normally catch this.
    throw new Error(
      `[acceptance-spec-reconciler] Epic #${epicId} body has no ## Acceptance Table section and no acceptance::n-a waiver label. Re-run /plan Phase 7 or apply the waiver.`,
    );
  }

  const acIds = parseAcIds(acceptanceSection);

  // 2. Scan feature files.
  const featureFiles = listFeatureFiles(dir);
  const tagSets = [];
  for (const filePath of featureFiles) {
    let content;
    try {
      content = readFeatureFile(filePath);
    } catch (err) {
      logger.warn?.(
        `[acceptance-spec-reconciler] failed to read ${filePath}: ${err?.message ?? err}`,
      );
      continue;
    }
    for (const set of collectScenarioTagSets(content)) {
      tagSets.push(set);
    }
  }

  if (acIds.length === 0) {
    logger.warn?.(
      `[acceptance-spec-reconciler] Epic #${epicId} acceptance-table section declares zero AC IDs — treating as empty spec.`,
    );
    return {
      epicId,
      status: 'empty-spec',
      ok: true,
      acIds: [],
      satisfied: [],
      pending: [],
      missing: [],
      featureFilesScanned: featureFiles.length,
      dispositionsUpdated: false,
    };
  }

  const { satisfied, pending, missing } = classifyCoverage({
    acIds,
    tagSets,
    epicId,
  });
  const ok = missing.length === 0 && pending.length === 0;

  // 3. Optional close-time disposition write-back. Section-scoped: the
  //    upsert replaces only the managed acceptance-table region; every
  //    byte outside it is preserved. Best-effort — a failed write is a
  //    warning, never a verdict change.
  let dispositionsUpdated = false;
  if (writeDispositions && typeof provider.updateTicket === 'function') {
    try {
      const rewrittenSection = renderDispositions(acceptanceSection, {
        satisfied,
        pending,
        missing,
      });
      if (rewrittenSection !== acceptanceSection) {
        const newBody = upsertEpicSection(
          epic.body ?? '',
          'acceptanceTable',
          rewrittenSection,
        );
        await provider.updateTicket(epicId, { body: newBody });
        dispositionsUpdated = true;
        logger.info?.(
          `[acceptance-spec-reconciler] Recorded verification dispositions for ${acIds.length} AC row(s) in Epic #${epicId}'s ## Acceptance Table section.`,
        );
      }
    } catch (err) {
      logger.warn?.(
        `[acceptance-spec-reconciler] disposition write-back failed (verdict unaffected): ${err?.message ?? err}`,
      );
    }
  }

  return {
    epicId,
    status: ok ? 'ok' : 'gap',
    ok,
    acIds,
    satisfied,
    pending,
    missing,
    featureFilesScanned: featureFiles.length,
    dispositionsUpdated,
  };
}

/**
 * Pure: classify parsed CLI values into a runnable intent. Mirrors the
 * pattern used by `epic-deliver-finalize.classifyFinalizeInvocation` so
 * the CC of `main` stays trivial.
 */
export function classifyReconcilerInvocation(values) {
  if (values?.help) return { kind: 'help' };
  const epicId = Number.parseInt(values?.epic ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    return {
      kind: 'usage-error',
      messages: [
        '[acceptance-spec-reconciler] ERROR: --epic <epicId> is required.',
        HELP,
      ],
    };
  }
  return {
    kind: 'run',
    epicId,
    featuresDir: values['features-dir'] ?? null,
    skipWhenWaived: values['skip-when-waived'] === true,
    writeDispositions: values['write-dispositions'] === true,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'features-dir': { type: 'string' },
      'skip-when-waived': { type: 'boolean' },
      'write-dispositions': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const intent = classifyReconcilerInvocation(values);
  if (intent.kind === 'help') {
    Logger.info(HELP);
    return;
  }
  if (intent.kind === 'usage-error') {
    for (const m of intent.messages) Logger.error(m);
    process.exit(2);
  }
  const result = await reconcileAcceptanceSpec({
    epicId: intent.epicId,
    featuresDir: intent.featuresDir ?? undefined,
    skipWhenWaived: intent.skipWhenWaived,
    writeDispositions: intent.writeDispositions,
  });
  // Always emit the structured envelope to stdout, even on non-OK, so a
  // caller capturing stdout can read the diff payload before reacting to
  // the thrown error / non-zero exit.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    throw new Error(
      renderBlockerMessage({
        epicId: result.epicId,
        missing: result.missing,
        pending: result.pending,
      }),
    );
  }
}

runAsCli(import.meta.url, main, { source: 'acceptance-spec-reconciler' });
