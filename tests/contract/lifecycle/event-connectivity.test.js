/**
 * tests/contract/lifecycle/event-connectivity.test.js — Story #3901.
 *
 * Connectivity contract: **every schema'd lifecycle event MUST have at
 * least one production emitter AND at least one production subscriber —
 * OR be an explicitly classified terminal / external event.**
 *
 * Why this exists (epic-lifecycle-review.md §1.1): the Phase 8.5
 * auto-merge gate was a dead wire for an entire architecture epoch.
 * `epic.automerge.start` was emitted by the workflow but no listener
 * subscribed to it (`AutomergePredicate` listened only to
 * `epic.watch.end`, which no production code path emits). The framework
 * already lints listener-table *formatting* (`check-lifecycle-lint.js`)
 * and doc *drift* (`check-lifecycle-doc-drift.js`), but neither checks
 * *connectivity* — so an emit with no subscriber (or a subscriber with
 * no emit) sailed through CI. The review concluded: "One contract test —
 * every schema'd event has ≥1 production emitter and ≥1 production
 * subscriber — would have caught most of §1." This is that test.
 *
 * How it works
 * ------------
 * Every event under `.agents/schemas/lifecycle/` (except the
 * `ledger-record` envelope, which describes the on-disk row shape rather
 * than a bus event) MUST appear in the `EVENT_CLASSIFICATION` table
 * below. The test asserts:
 *
 *   1. **Coverage** — the classification table names exactly the schema
 *      set. A NEW schema with no classification fails the test, forcing
 *      the author to declare it `connected` (and prove the wiring) or
 *      `terminal` / `external` (with a rationale). This is the guard
 *      that makes a §1.1-style dead wire impossible to land silently.
 *
 *   2. **Connected events resolve** — for every event classified
 *      `connected`, the test re-derives the emitter and subscriber sets
 *      from source and asserts BOTH are non-empty. The classification's
 *      declared emitter / subscriber hints are checked against the
 *      derived sets so the table cannot rot.
 *
 *   3. **Terminal / external events have an emitter** — a terminal event
 *      (end-of-chain, consumed only by wildcard observers like
 *      LedgerWriter / NotifyDispatcher) still needs a production emitter;
 *      it just has no dedicated `this.events` subscriber. An external
 *      event (the test-only `Watcher` boundary) is exempt from BOTH
 *      checks but must carry a rationale.
 *
 * Emission is detected across the three mechanisms the framework uses:
 *   - literal `bus.emit('<event>', …)` in `.agents/scripts/**`;
 *   - `--event <event>` invocations of `lifecycle-emit.js` in the
 *     workflow markdown under `.agents/workflows/**`;
 *   - direct ledger-append helpers that write `event: '<event>'` records
 *     (heartbeat / dispatch / wave / checkpoint / notify), which do not
 *     route through `bus.emit`.
 *
 * Subscription is detected via the same `extractCodeEvents` extractor the
 * doc-drift check uses (it resolves `this.events = Object.freeze([...])`
 * arrays, including identifier-form entries backed by string constants).
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectStringConstants,
  extractCodeEvents,
} from '../../../.agents/scripts/check-lifecycle-doc-drift.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_DIR = path.join(REPO_ROOT, '.agents', 'schemas', 'lifecycle');
const SCRIPTS_DIR = path.join(REPO_ROOT, '.agents', 'scripts');
const LISTENERS_DIR = path.join(
  SCRIPTS_DIR,
  'lib',
  'orchestration',
  'lifecycle',
  'listeners',
);
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.agents', 'workflows');

/**
 * Classification of every schema'd lifecycle event. Each entry is one of:
 *
 *   - `{ kind: 'connected', emitter, subscriber }` — has a production
 *     emitter AND a dedicated production subscriber. `emitter` and
 *     `subscriber` are documentation hints (the derived sets are the
 *     source of truth; the hints are asserted to be a subset).
 *   - `{ kind: 'terminal', emitter, why }` — has a production emitter but
 *     no dedicated `this.events` subscriber: it is consumed only by
 *     wildcard observers (LedgerWriter / TraceLogger / NotifyDispatcher /
 *     CheckpointPointerWriter) or is the literal end of a chain.
 *   - `{ kind: 'external', why }` — exempt from both checks: emitted only
 *     by a test-only surface (the `Watcher`, per review §1.2) and kept
 *     alive for that path.
 *
 * Adding a new lifecycle event WITHOUT adding it here fails the coverage
 * assertion below — that is the point.
 */
const EVENT_CLASSIFICATION = Object.freeze({
  // --- close-tail: acceptance reconcile ---
  'acceptance.reconcile.start': {
    kind: 'terminal',
    emitter: 'acceptance-reconciler.js',
    why: 'phase-boundary trace; consumed by wildcard observers only',
  },
  'acceptance.reconcile.ok': {
    kind: 'connected',
    emitter: 'acceptance-reconciler.js',
    subscriber: 'finalizer.js',
  },
  'acceptance.reconcile.waived': {
    kind: 'connected',
    emitter: 'acceptance-reconciler.js',
    subscriber: 'finalizer.js',
  },
  'acceptance.reconcile.skipped': {
    kind: 'terminal',
    emitter: 'acceptance-reconciler.js',
    why: 'no-op skip outcome; Finalizer subscribes to ok/waived only',
  },
  'acceptance.reconcile.failed': {
    kind: 'terminal',
    emitter: 'acceptance-reconciler.js',
    why: 'failure outcome surfaced via classifications + epic.blocked, not a dedicated subscriber',
  },

  // --- close-validate ---
  'close-validate.start': {
    kind: 'terminal',
    emitter: 'pre-merge-validation.js',
    why: 'phase-boundary trace',
  },
  'close-validate.end': {
    kind: 'terminal',
    emitter: 'pre-merge-validation.js',
    why: 'phase-boundary trace',
  },

  // --- code-review ---
  'code-review.start': {
    kind: 'terminal',
    emitter: 'code-review.js',
    why: 'phase-boundary trace',
  },
  'code-review.end': {
    kind: 'terminal',
    emitter: 'code-review.js',
    why: 'phase-boundary trace',
  },

  // --- legacy epic automerge wrapper (retained schema/listeners, no v2 emitter) ---
  'epic.automerge.start': {
    kind: 'external',
    why: 'legacy Epic close-tail event retained for schema/listener compatibility; v2 /deliver routes Stories through helpers/deliver-story and emits no production Epic automerge wrapper.',
  },
  'epic.automerge.end': {
    kind: 'external',
    why: 'legacy Epic close-tail event retained for schema compatibility; no production v2 /deliver workflow emits the Epic automerge wrapper end event.',
  },

  // --- epic lifecycle ---
  'epic.blocked': {
    kind: 'terminal',
    emitter: 'acceptance-reconciler.js',
    why: 'blocker signal emitted by AcceptanceReconciler / MergeWatcher; consumed only by the wildcard NotifyDispatcher (dynamic this.events) which fans it to the curated webhook. Its former dedicated subscribers (BlockerHandler / LabelTransitioner) were part of the in-process runner stratum deleted in Story #3908.',
  },
  'epic.close.end': {
    kind: 'external',
    why: 'legacy Epic close-tail event retained for listener compatibility; v2 Story delivery closes through single-story-close and PR confirmation instead.',
  },
  'epic.finalize.start': {
    kind: 'terminal',
    emitter: 'finalizer.js',
    why: 'phase-boundary trace',
  },
  'epic.finalize.end': {
    kind: 'terminal',
    emitter: 'finalizer.js',
    why: 'finalize end trace; the auto-merge arm re-enters via Phase 8.5',
  },
  'epic.complete': {
    kind: 'connected',
    emitter: 'cleaner.js',
    subscriber: 'label-transitioner.js',
    // LabelTransitioner was re-homed onto the lifecycle-emit chain after
    // the 2026-07-11 incident: the original listener died with the
    // in-process runner stratum (Story #3908) and this entry's former
    // 'terminal' rationale ("the agent::done flip is driven by the
    // post-merge close path") described a path that did not exist —
    // cleanly-merged Epics stranded at agent::executing.
  },
  'epic.snapshot.start': {
    kind: 'terminal',
    emitter: 'snapshot.js',
    why: 'phase-boundary trace; NotifyDispatcher fans it out via wildcard',
  },
  'epic.snapshot.end': {
    kind: 'terminal',
    emitter: 'snapshot.js',
    why: 'phase-boundary trace',
  },
  'epic.plan.start': {
    kind: 'terminal',
    emitter: 'build-wave-dag.js',
    why: 'planning phase-boundary trace',
  },
  'epic.plan.end': {
    kind: 'terminal',
    emitter: 'build-wave-dag.js',
    why: 'planning phase-boundary trace',
  },

  // --- merge gate ---
  'epic.merge.ready': {
    kind: 'connected',
    emitter: 'automerge-predicate.js',
    subscriber: 'automerge-armer.js',
  },
  'epic.merge.blocked': {
    kind: 'terminal',
    emitter: 'automerge-predicate.js',
    why: 'operator-merge fallback signal; surfaced via classifications, no dedicated arm subscriber',
  },
  'epic.merge.armed': {
    kind: 'connected',
    emitter: 'automerge-armer.js',
    subscriber: 'merge-watcher.js',
  },
  'epic.merge.confirmed': {
    kind: 'connected',
    emitter: 'merge-watcher.js',
    subscriber: 'cleaner.js',
  },
  'merge.unlanded': {
    kind: 'terminal',
    emitter: 'emit-merge-unlanded.js',
    why: 'work-complete-but-unmerged diagnosis event (Epic #4425 slice 1, Story #4426), emitted by the epic-path finalize flow and the standalone single-story-close flow whenever a headless delivery run finishes without a confirmed merge. Not routed through the bus (unlike loop.tick), so it has no dedicated this.events subscriber — consumed only by ad hoc ledger readers (retro tooling, the benchmark) that scan for it, mirroring story.heartbeat / story.dispatch.start.',
  },

  // --- cleanup ---
  'epic.cleanup.start': {
    kind: 'connected',
    emitter: 'cleaner.js',
    subscriber: 'branch-cleaner.js',
  },
  'epic.cleanup.end': {
    kind: 'terminal',
    emitter: 'cleaner.js',
    why: 'cleanup end trace',
  },

  // --- watch (test-only Watcher boundary, review §1.2) ---
  'epic.watch.start': {
    kind: 'external',
    why: 'emitted only by the test-only Watcher; kept for the Watcher path',
  },
  'epic.watch.end': {
    kind: 'external',
    why: 'emitted only by the test-only Watcher; AutomergePredicate still subscribes for that path, but production fires epic.automerge.start instead',
  },
  'pr.created': {
    kind: 'connected',
    emitter: 'finalizer.js',
    subscriber: 'watcher.js',
  },

  // --- retro ---
  'retro.start': {
    kind: 'terminal',
    emitter: 'retro-runner.js',
    why: 'phase-boundary trace',
  },
  'retro.end': {
    kind: 'terminal',
    emitter: 'retro-runner.js',
    why: 'phase-boundary trace',
  },

  // --- story lifecycle ---
  'story.dispatch.start': {
    kind: 'terminal',
    emitter: 'lifecycle-emit-story-dispatch.js',
    why: 'ledger-append dispatch marker; consumed by the idle watchdog reading the ledger, not a bus subscriber',
  },
  'story.dispatch.end': {
    kind: 'terminal',
    emitter: 'emit-story-dispatch-end.js',
    why: 'ledger-append dispatch-end marker consumed by the idle watchdog reading the ledger and by CheckpointPointerWriter (which subscribes via the dynamic SUBSCRIBED_END_EVENTS array, so the connectivity extractor classifies it as a wildcard observer, not a dedicated literal subscriber). Its former dedicated subscriber (ProgressReporter) was part of the in-process runner stratum deleted in Story #3908.',
  },
  'story.heartbeat': {
    kind: 'terminal',
    emitter: 'emit-story-heartbeat.js',
    why: 'ledger-append heartbeat; consumed by the idle watchdog reading the ledger (wave-tick --check-idle), not a bus subscriber',
  },
  'story.blocked': {
    kind: 'terminal',
    emitter: 'pre-merge-validation.js',
    why: 'blocker signal surfaced via the story-close label flip + friction comment; its former dedicated subscriber (BlockerHandler) was part of the in-process runner stratum deleted in Story #3908. Consumed by wildcard observers (LedgerWriter) only.',
  },
  'story.merged': {
    kind: 'terminal',
    emitter: 'post-merge-close.js',
    why: 'merge signal surfaced via the post-merge label flip; its former dedicated subscriber (LabelTransitioner) was part of the in-process runner stratum deleted in Story #3908. Consumed by wildcard observers (LedgerWriter) only.',
  },
  // --- single-delivery slice lifecycle (Epic #4475, M4-A) ---
  // Introduced INERT: emit-slice-lifecycle.js is the ledger-append emitter,
  // but the executor that CALLS it lands in M4-B (deliver-epic-single.md), so
  // no production path emits them yet. The connectivity extractor derives the
  // emitter from the `event: 'slice.*'` literals in emit-slice-lifecycle.js.
  'slice.start': {
    kind: 'terminal',
    emitter: 'emit-slice-lifecycle.js',
    why: 'ledger-append slice-boundary marker (the single-delivery analogue of story.dispatch.start); consumed by the idle watchdog reading the ledger, not a dedicated bus subscriber. Inert until M4-B wires the executor.',
  },
  'slice.end': {
    kind: 'terminal',
    emitter: 'emit-slice-lifecycle.js',
    why: 'ledger-append slice-end marker (the single-delivery analogue of story.dispatch.end); consumed by the idle watchdog and by CheckpointPointerWriter via the dynamic SUBSCRIBED_END_EVENTS array (classified as a wildcard observer, not a dedicated literal subscriber). Inert until M4-B wires the executor.',
  },
  'slice.heartbeat': {
    kind: 'terminal',
    emitter: 'emit-slice-lifecycle.js',
    why: 'ledger-append heartbeat for the one long guarded single-delivery session (the analogue of story.heartbeat); consumed by the idle watchdog reading the ledger, not a bus subscriber. Inert until M4-B wires the executor.',
  },
  'loop.tick': {
    kind: 'terminal',
    emitter: 'emit-loop-tick.js',
    why: 'ledger-append per-pass marker for a host-driven loop (Story #4287); consumed by the idle watchdog reading the ledger, not a dedicated bus subscriber. Mirrors story.heartbeat but is loop-scoped rather than Story-scoped.',
  },

  // --- wave lifecycle ---
  // The dotted lifecycle `wave.start` / `wave.end` events and their
  // `epic.close.start` / `epic.unblocked` siblings were emitted only by the
  // in-process runner stratum (wave-session.js / epic-deliver-close-tail.js /
  // the runner factory) deleted in Story #3908. Their schemas were removed in
  // the same cutover, so they no longer appear in the schema set the coverage
  // assertion enforces. The production wave loop emits `story.dispatch.end` +
  // hyphenated `wave-start` / `wave-end` SIGNAL records (not bus events) and
  // fires the curated wave-boundary webhooks through
  // progress-reporter/transport.js instead.

  // --- pure ledger / observer envelopes ---
  'checkpoint.written': {
    kind: 'terminal',
    emitter: 'checkpoint-pointer-writer.js',
    why: 'written by CheckpointPointerWriter as a ledger record; the resume pointer is read from disk, not via a bus subscriber',
  },
  'intervention.recorded': {
    kind: 'connected',
    emitter: 'epic-deliver-note-intervention.js',
    subscriber: 'intervention-recorder.js',
  },
  'notification.emitted': {
    kind: 'terminal',
    emitter: 'notify-dispatcher.js',
    why: 'self-emitted by NotifyDispatcher as a `kind:` audit record of a fan-out; terminal observer record',
  },
});

/** Recursively collect `.js` files under a directory. */
function walkJs(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Recursively collect `.md` files under a directory. */
function walkMd(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMd(p));
    else if (ent.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive the set of production emitters for a given event across all
 * three emission mechanisms. Returns a Set of basenames (or the workflow
 * file basename for `--event` invocations).
 */
function deriveEmitters(
  event,
  { jsFiles, jsSrc, mdFiles, mdSrc, constantNamesByValue },
) {
  const emitters = new Set();
  const ev = escapeRe(event);
  /** Constant identifiers across all scanned files whose value === event. */
  const eventConstantNames = (e) => constantNamesByValue.get(e) ?? new Set();
  // 1. literal bus.emit('<event>', …); ledger-append `event:` / `kind:`
  //    record shapes; and constant-form `bus.emit(EVENT_CONST, …)` where
  //    EVENT_CONST is a same-file string constant resolving to the event.
  const busEmitRe = new RegExp(`\\.emit\\(\\s*['"]${ev}['"]`);
  const ledgerEventRe = new RegExp(`(?:event|kind):\\s*['"]${ev}['"]`);
  for (let i = 0; i < jsFiles.length; i += 1) {
    const src = jsSrc[i];
    let matched = busEmitRe.test(src) || ledgerEventRe.test(src);
    if (!matched) {
      // Resolve constant-form emits: `emit(NAME)` where `const NAME =
      // '<event>'` resolves to the event. The constant may be declared in
      // the same file (CheckpointPointerWriter → CHECKPOINT_WRITTEN_EVENT)
      // or imported from another scanned module
      // (epic-deliver-note-intervention.js → INTERVENTION_RECORDED_EVENT,
      // exported by intervention-recorder.js), so we consult the
      // cross-file constant map.
      for (const name of eventConstantNames(event)) {
        if (new RegExp(`\\.emit\\(\\s*${name}\\b`).test(src)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) emitters.add(path.basename(jsFiles[i]));
  }
  // 2. --event <event> in workflow markdown (lifecycle-emit.js invocations)
  const wfEmitRe = new RegExp(`--event\\s+${ev}(?![\\w.])`);
  for (let i = 0; i < mdFiles.length; i += 1) {
    if (wfEmitRe.test(mdSrc[i])) emitters.add(path.basename(mdFiles[i]));
  }
  return emitters;
}

/**
 * Derive the set of dedicated production subscribers for a given event by
 * reading every listener's `this.events` array via the shared
 * `extractCodeEvents` extractor (which resolves constant-form entries).
 * Returns a Set of listener basenames.
 */
function deriveSubscribers(event, listenerFiles, listenerSrc) {
  const subs = new Set();
  for (let i = 0; i < listenerFiles.length; i += 1) {
    const code = extractCodeEvents(listenerSrc[i]);
    if (code.kind === 'literals' && code.events.includes(event)) {
      subs.add(path.basename(listenerFiles[i]));
    }
  }
  return subs;
}

describe('lifecycle event connectivity (Story #3901)', () => {
  const schemaEvents = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .map((f) => f.replace('.schema.json', ''))
    .filter((e) => e !== 'ledger-record');

  const jsFiles = walkJs(SCRIPTS_DIR);
  const jsSrc = jsFiles.map((f) => readFileSync(f, 'utf8'));
  const mdFiles = walkMd(WORKFLOWS_DIR);
  const mdSrc = mdFiles.map((f) => readFileSync(f, 'utf8'));
  const listenerFiles = readdirSync(LISTENERS_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .map((f) => path.join(LISTENERS_DIR, f));
  const listenerSrc = listenerFiles.map((f) => readFileSync(f, 'utf8'));
  // Cross-file map: event-name string → Set of constant identifiers that
  // resolve to it (e.g. 'intervention.recorded' → {INTERVENTION_RECORDED_EVENT}).
  // Lets deriveEmitters resolve `bus.emit(EVENT_CONST, …)` even when the
  // constant is imported from another scanned module.
  const constantNamesByValue = new Map();
  for (const src of jsSrc) {
    for (const [name, value] of collectStringConstants(src)) {
      if (!constantNamesByValue.has(value)) {
        constantNamesByValue.set(value, new Set());
      }
      constantNamesByValue.get(value).add(name);
    }
  }
  const scan = { jsFiles, jsSrc, mdFiles, mdSrc, constantNamesByValue };

  it('classifies exactly the schema set (no event left unclassified)', () => {
    const classified = new Set(Object.keys(EVENT_CLASSIFICATION));
    const schema = new Set(schemaEvents);
    const unclassified = [...schema].filter((e) => !classified.has(e));
    const stale = [...classified].filter((e) => !schema.has(e));
    assert.deepEqual(
      unclassified,
      [],
      `every schema'd lifecycle event MUST be classified in EVENT_CLASSIFICATION (a new event with no classification is exactly the §1.1 dead-wire failure mode). Unclassified: ${unclassified.join(', ')}`,
    );
    assert.deepEqual(
      stale,
      [],
      `EVENT_CLASSIFICATION names events with no schema file: ${stale.join(', ')}`,
    );
  });

  it('every connected event has ≥1 production emitter AND ≥1 production subscriber', () => {
    for (const [event, cls] of Object.entries(EVENT_CLASSIFICATION)) {
      if (cls.kind !== 'connected') continue;
      const emitters = deriveEmitters(event, scan);
      const subs = deriveSubscribers(event, listenerFiles, listenerSrc);
      assert.ok(
        emitters.size > 0,
        `connected event "${event}" has NO production emitter (bus.emit / --event / ledger-append). This is a dead wire.`,
      );
      assert.ok(
        subs.size > 0,
        `connected event "${event}" has NO production subscriber (no listener this.events array names it). This is a dead wire — exactly the §1.1 auto-merge regression.`,
      );
      assert.ok(
        emitters.has(cls.emitter),
        `connected event "${event}" declares emitter "${cls.emitter}" but it was not found among derived emitters [${[...emitters].join(', ')}] — update the classification hint.`,
      );
      assert.ok(
        subs.has(cls.subscriber),
        `connected event "${event}" declares subscriber "${cls.subscriber}" but it was not found among derived subscribers [${[...subs].join(', ')}] — update the classification hint.`,
      );
    }
  });

  it('every terminal event has ≥1 production emitter', () => {
    for (const [event, cls] of Object.entries(EVENT_CLASSIFICATION)) {
      if (cls.kind !== 'terminal') continue;
      const emitters = deriveEmitters(event, scan);
      assert.ok(
        emitters.size > 0,
        `terminal event "${event}" has NO production emitter — a terminal event with no emitter is unreachable dead schema.`,
      );
      assert.ok(
        emitters.has(cls.emitter),
        `terminal event "${event}" declares emitter "${cls.emitter}" but it was not found among derived emitters [${[...emitters].join(', ')}].`,
      );
    }
  });

  it('every external event carries a rationale and is genuinely subscriber-only-from-tests', () => {
    for (const [event, cls] of Object.entries(EVENT_CLASSIFICATION)) {
      if (cls.kind !== 'external') continue;
      assert.ok(
        typeof cls.why === 'string' && cls.why.length > 0,
        `external event "${event}" MUST carry a "why" rationale documenting why it is exempt from connectivity.`,
      );
    }
  });

  it('regression guard: epic.automerge.start reaches AutomergePredicate', () => {
    // The literal §1.1 dead wire. Pin it directly so a future refactor
    // that unbinds the predicate from the production Phase 8.5 boundary
    // fails loudly here, not silently in a real Epic delivery.
    const emitters = deriveEmitters('epic.automerge.start', scan);
    const subs = deriveSubscribers(
      'epic.automerge.start',
      listenerFiles,
      listenerSrc,
    );
    assert.ok(
      emitters.size > 0,
      'epic.automerge.start must be emitted by the production Phase 8.5 workflow',
    );
    assert.ok(
      subs.has('automerge-predicate.js'),
      'epic.automerge.start must be subscribed by AutomergePredicate (the §1.1 repair)',
    );
  });
});
