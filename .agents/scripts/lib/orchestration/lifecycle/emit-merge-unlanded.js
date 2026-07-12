/**
 * emit-merge-unlanded.js — Story #4426 (Epic #4425, slice 1: foundation).
 *
 * Programmatic helper that appends a single `merge.unlanded` NDJSON
 * record to the lifecycle ledger whenever a headless delivery run
 * finishes its work without a confirmed merge. Pattern mirrors
 * `emit-story-heartbeat.js`: direct schema validation via Ajv followed by
 * a synchronous `appendFileSync` — this event is NOT routed through the
 * bus (unlike `emit-loop-tick.js`) because it can fire from either the
 * epic-path finalize flow (which already owns an Epic-scoped bus
 * instance for its own run) or the standalone `single-story-close` flow,
 * which has no bus at all. A bare append keeps both call sites simple
 * and dependency-free.
 *
 * Ledger destination is scope-driven (Story #4426 AC4):
 *   - `scope: 'epic'`  → `epicLedgerPath(ticketId)` — the same
 *     `temp/epic-<id>/lifecycle.ndjson` every other Epic-scoped event
 *     lands in. `ticketId` is the epicId.
 *   - `scope: 'story'` → `storyLedgerPath(null, ticketId)` — the
 *     standalone story-scope destination
 *     `temp/standalone/stories/story-<id>/lifecycle.ndjson`. `ticketId`
 *     is the storyId. The standalone `single-story-close` path has no
 *     parent Epic to anchor a `temp/epic-<id>/` directory to, mirroring
 *     the `eid === null` standalone convention `signalsFile` already
 *     uses for Story-level signals.
 *
 * A caller may always override the destination via `ledgerPath` (tests,
 * or a future caller with a non-default temp layout).
 *
 * Distinct from:
 *   - `epic.merge.blocked` — AutomergePredicate's "not safe to arm yet"
 *     signal, evaluated BEFORE arming. `merge.unlanded` fires AFTER a
 *     delivery flow has already finished trying and gives up.
 *   - `epic.blocked` / `story.blocked` — the generic `agent::blocked`
 *     transition signal. `merge.unlanded` is the merge-specific
 *     diagnosis a `*.blocked` transition is typically paired with, not a
 *     replacement for it.
 *
 * The emit is best-effort in the sense that a failure to append MUST NOT
 * mask the underlying blocked-state transition the caller is already
 * driving — callers should treat this the same way
 * `emitStoryHeartbeat` documents: catch, log, and proceed with the label
 * flip / friction comment regardless.
 *
 * Schema contract (merge.unlanded.schema.json):
 *   { event, scope, ticketId, prNumber, blockClass, reason,
 *     elapsedSeconds, timestamp? }
 *
 * The schema declares `additionalProperties: false`, so this emitter's
 * signature is deliberately narrow: only the schema-allowed fields are
 * accepted. `blockClass` MUST be a valid `merge.unlanded` attribution from
 * `merge-block-class.js` (`MERGE_UNLANDED_BLOCK_CLASSES` — the four
 * `classifyMergeBlock` outputs plus the directly-emitted `predicate-refused`,
 * Story #4472). For a post-arm poll-exhaustion block, pass the classifier's
 * verdict straight through (`classifyMergeBlock(...)` returns
 * `{ blockClass, reason }`); the predicate/armer refusal paths pass
 * `predicate-refused` / a classified arm failure directly.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { epicLedgerPath, storyLedgerPath } from '../../config/temp-paths.js';
import { isValidBlockClass } from '../merge-block-class.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'schemas',
  'lifecycle',
  'merge.unlanded.schema.json',
);

const VALID_SCOPES = new Set(['epic', 'story']);

let _validator;

function getValidator() {
  if (_validator) return _validator;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  _validator = ajv.compile(schema);
  return _validator;
}

/**
 * Append exactly one `merge.unlanded` NDJSON record to the resolved
 * lifecycle ledger.
 *
 * @param {object} opts
 * @param {'epic'|'story'} opts.scope  Which delivery path is reporting the
 *                                     unlanded merge.
 * @param {number} opts.ticketId       epicId when `scope === 'epic'`,
 *                                     storyId when `scope === 'story'`.
 * @param {number} opts.prNumber       The PR number that did not land.
 * @param {string} opts.blockClass     A valid `merge.unlanded` attribution
 *                                     (`MERGE_UNLANDED_BLOCK_CLASSES` in
 *                                     `merge-block-class.js`).
 * @param {string} opts.reason         Free-form diagnosis detail — pass
 *                                     the classifier's `reason`.
 * @param {number} opts.elapsedSeconds Elapsed watch/poll time when the
 *                                     run gave up.
 * @param {string} [opts.timestamp]    ISO-8601 wall clock. Defaults to
 *                                     now().
 * @param {object} [opts.config]       Optional resolved config for
 *                                     tempRoot.
 * @param {string} [opts.ledgerPath]   Override for tests / non-default
 *                                     layouts.
 * @returns {{ ledgerPath: string, record: object }}
 */
export function emitMergeUnlanded(opts) {
  const {
    scope,
    ticketId,
    prNumber,
    blockClass,
    reason,
    elapsedSeconds,
    timestamp = new Date().toISOString(),
    config,
    ledgerPath: ledgerPathOverride,
  } = opts ?? {};

  if (!VALID_SCOPES.has(scope)) {
    throw new Error(
      `emitMergeUnlanded: scope "${scope}" must be one of: ${[...VALID_SCOPES].join(', ')}`,
    );
  }
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    throw new Error('emitMergeUnlanded: ticketId must be a positive integer');
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error('emitMergeUnlanded: prNumber must be a positive integer');
  }
  if (!isValidBlockClass(blockClass)) {
    throw new Error(
      `emitMergeUnlanded: blockClass "${blockClass}" is not a recognised merge-block-class value`,
    );
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('emitMergeUnlanded: reason must be a non-empty string');
  }
  if (typeof elapsedSeconds !== 'number' || elapsedSeconds < 0) {
    throw new Error(
      'emitMergeUnlanded: elapsedSeconds must be a non-negative number',
    );
  }

  const payload = {
    event: 'merge.unlanded',
    scope,
    ticketId,
    prNumber,
    blockClass,
    reason,
    elapsedSeconds,
    timestamp,
  };

  const validator = getValidator();
  if (!validator(payload)) {
    const detail = (validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `emitMergeUnlanded: payload failed schema validation: ${detail}`,
    );
  }

  const ledgerPath =
    ledgerPathOverride ??
    (scope === 'epic'
      ? epicLedgerPath(ticketId, config)
      : storyLedgerPath(null, ticketId, config));
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const record = {
    kind: 'emitted',
    ts: timestamp,
    event: 'merge.unlanded',
    payload,
  };
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { ledgerPath, record };
}
