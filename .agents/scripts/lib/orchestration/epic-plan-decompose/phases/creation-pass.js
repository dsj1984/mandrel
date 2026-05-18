/**
 * creation-pass.js — staged-pass ticket creation helpers for the
 * epic-plan-decompose pipeline (Story #2466).
 *
 * Split out of `creation.js` so each phase file stays under the 200-LOC
 * cap mandated for Story #2466. This module owns the per-pass deferred
 * slug map, the intra-pass dependency-wait helper, and the
 * `runCreationPass(...)` driver.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/creation-pass
 */

import { Logger } from '../../../Logger.js';
import { concurrentMap } from '../../../util/concurrent-map.js';
import { resolveDependencies, resolveParentId } from './dag.js';

function buildDeferredSlugMap(tickets) {
  const deferred = new Map();
  for (const t of tickets) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Swallow rejection bookkeeping so a failed creation does not surface
    // as an unhandled rejection when no dependent ticket awaits this
    // promise. The original error is still re-thrown inside the mapper
    // and observed by concurrentMap's first-rejection-wins contract.
    promise.catch(() => {});
    deferred.set(t.slug, { promise, resolve, reject });
  }
  return deferred;
}

async function awaitIntraPassDeps(ticket, deferred) {
  for (const depSlug of ticket.depends_on ?? []) {
    if (deferred.has(depSlug)) await deferred.get(depSlug).promise;
  }
}

function maybeUseExistingChild(t, childIndex, slugMap, deferred) {
  const existingEntry = childIndex.get(t.title);
  if (existingEntry && existingEntry.state !== 'closed') {
    Logger.info(
      `[Decomposer] SKIP (already created): #${existingEntry.id} ${t.title}`,
    );
    slugMap.set(t.slug, existingEntry.id);
    deferred.get(t.slug).resolve(existingEntry.id);
    return existingEntry.id;
  }
  if (existingEntry && existingEntry.state === 'closed') {
    Logger.warn(
      `[Decomposer] Existing CLOSED #${existingEntry.id} matches planned title "${t.title}" — re-creating (prior decomposition was cancelled).`,
    );
  }
  return null;
}

function resolveAuditSnapshot(t) {
  if (t.type !== 'task') return undefined;
  if (!t.body || typeof t.body !== 'object') return undefined;
  return new Date().toISOString().slice(0, 10);
}

async function createOneTicket({ t, epicId, provider, slugMap, deferred }) {
  Logger.info(
    `[Decomposer] [${t.type.toUpperCase()}] Creating "${t.title}"...`,
  );
  const parentId = resolveParentId(t, slugMap, epicId);
  const dependencies = resolveDependencies(t, slugMap);
  const auditSnapshot = resolveAuditSnapshot(t);
  try {
    const created = await provider.createTicket(parentId, {
      epicId,
      title: t.title,
      body: t.body,
      labels: t.labels || [],
      dependencies,
      auditSnapshot,
    });
    Logger.info(`[Decomposer] -> Created Issue #${created.id}`);
    slugMap.set(t.slug, created.id);
    deferred.get(t.slug).resolve(created.id);
    return created.id;
  } catch (err) {
    deferred.get(t.slug).reject(err);
    throw err;
  }
}

/**
 * Run one staged creation pass with bounded concurrency. Intra-group
 * `depends_on` chains are honoured via per-slug deferred promises: a
 * ticket's mapper awaits each dep's promise before reading the slugMap,
 * so a chain like t-a → t-b → t-c serialises naturally even when the
 * cap permits parallel work.
 */
export async function runCreationPass(
  tickets,
  slugMap,
  epicId,
  provider,
  concurrencyCap,
  childIndex = new Map(),
) {
  const deferred = buildDeferredSlugMap(tickets);
  await concurrentMap(
    tickets,
    async (t) => {
      await awaitIntraPassDeps(t, deferred);
      const reused = maybeUseExistingChild(t, childIndex, slugMap, deferred);
      if (reused !== null) return reused;
      return createOneTicket({ t, epicId, provider, slugMap, deferred });
    },
    { concurrency: concurrencyCap },
  );
}
