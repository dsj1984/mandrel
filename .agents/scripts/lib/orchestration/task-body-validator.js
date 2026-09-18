/**
 * Story body schema validator. String bodies (the canonical serialized form)
 * are parsed before checking. Requires a non-empty `goal`, `acceptance`, and
 * `changes` of `{ path, assumption }` objects; `references` is optional, same
 * shape. `verify` is not scored. Errors are batched into one throw.
 */

import { suggestPathEntryFix } from '../story-body/body-format-lints.js';
import {
  parse as parseStoryBody,
  StoryBodyParseError,
} from '../story-body/story-body.js';
import { FILE_ASSUMPTION_VALUES } from './file-assumption-enum.js';

/**
 * Non-Stories and empty bodies are skipped; string bodies are NOT.
 *
 * @param {object} ticket
 * @returns {boolean}
 */
function shouldSkipTicket(ticket) {
  if (!ticket) return true;
  if (ticket.type !== 'story') return true;
  const body = ticket.body;
  if (body == null) return true;
  if (typeof body === 'string' && body.trim() === '') return true;
  return false;
}

/**
 * @param {object} ticket Story whose body passed `shouldSkipTicket`.
 * @returns {{ body: object|null, error: string|null }} Mutually exclusive.
 */
function resolveStructuredBody(ticket) {
  const raw = ticket.body;
  if (typeof raw !== 'string') {
    return { body: raw, error: null };
  }
  const prefix = `Story "${ticket.title}" (${ticket.slug})`;
  try {
    return { body: parseStoryBody(raw).body, error: null };
  } catch (err) {
    const reason =
      err instanceof StoryBodyParseError ? err.message : String(err);
    return {
      body: null,
      error: `${prefix}: body string could not be parsed as a structured Story body: ${reason}`,
    };
  }
}

const CONTRACT_FIELDS = Object.freeze(['acceptance', 'verify']);

/**
 * Fall back to top-level `acceptance[]` / `verify[]` (the preferred authoring
 * shape): assembly syncs them into the body only after validation. A
 * disagreeing body section is left to the sync, which fails closed.
 *
 * @param {object} ticket
 * @param {object} bodyObject
 * @returns {object} A copy of `bodyObject` with the contract fields resolved.
 */
function resolveContractFieldsFromTopLevel(ticket, bodyObject) {
  const resolved = { ...bodyObject };
  for (const field of CONTRACT_FIELDS) {
    const bodyValue = Array.isArray(resolved[field]) ? resolved[field] : [];
    if (bodyValue.length > 0) continue;
    const topLevel = Array.isArray(ticket?.[field]) ? ticket[field] : [];
    if (topLevel.length === 0) continue;
    resolved[field] = topLevel.map(String);
  }
  return resolved;
}

/**
 * @param {object} ticket Story whose `body` passed `shouldSkipTicket`.
 * @returns {string[]}
 */
export function validateTaskBodyShape(ticket) {
  const prefix = `Story "${ticket.title}" (${ticket.slug})`;
  const { body: parsed, error } = resolveStructuredBody(ticket);
  if (error !== null) {
    return [error];
  }
  if (parsed === null || typeof parsed !== 'object') {
    return [`${prefix}: body must be an object, got ${typeof parsed}.`];
  }
  const body = resolveContractFieldsFromTopLevel(ticket, parsed);
  const errors = [];
  if (typeof body.goal !== 'string' || body.goal.trim() === '') {
    errors.push(`${prefix}: body.goal must be a non-empty string.`);
  }
  errors.push(...collectChangesErrors(prefix, body.changes));
  errors.push(...collectAcceptanceErrors(prefix, body.acceptance));
  errors.push(...collectReferencesErrors(prefix, body.references));
  return errors;
}

/**
 * @param {unknown} entry
 * @returns {entry is { path: string, assumption: typeof FILE_ASSUMPTION_VALUES[number] }}
 */
export function isObjectPathEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (typeof entry.path !== 'string' || entry.path.trim() === '') return false;
  if (!FILE_ASSUMPTION_VALUES.includes(entry.assumption)) return false;
  return true;
}

/**
 * An object that is not a valid entry, so it gets a specific error message.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isMalformedObjectPathEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (isObjectPathEntry(entry)) return false;
  return true;
}

/**
 * @param {string} prefix
 * @param {unknown} rawChanges
 * @returns {string[]}
 */
function collectChangesErrors(prefix, rawChanges) {
  const changes = Array.isArray(rawChanges) ? rawChanges : [];
  if (changes.length === 0) {
    return [`${prefix}: body.changes must list at least one bullet.`];
  }
  const errors = [];
  const namesPath = (c) => isObjectPathEntry(c);
  if (changes.every((c) => !namesPath(c))) {
    errors.push(
      `${prefix}: body.changes must declare at least one { path, assumption } object entry.`,
    );
  }
  for (const entry of changes) {
    if (typeof entry === 'string') {
      const fix = suggestPathEntryFix(entry);
      const fixIt =
        fix === null
          ? ''
          : ` Suggested fix: ${fix} (adjust the assumption to creates|deletes if this is a new file or a removal).`;
      errors.push(
        `${prefix}: body.changes entry must be a { path, assumption } object; plain string bullets are no longer accepted: "${entry}".${fixIt}`,
      );
      continue;
    }
    if (isMalformedObjectPathEntry(entry)) {
      errors.push(
        `${prefix}: body.changes object entry must declare { path: <string>, assumption: one of ${FILE_ASSUMPTION_VALUES.join('|')} }. Got: ${JSON.stringify(entry)}.`,
      );
    }
  }
  return errors;
}

/**
 * @param {string} prefix
 * @param {unknown} rawReferences
 * @returns {string[]}
 */
function collectReferencesErrors(prefix, rawReferences) {
  if (rawReferences === undefined || rawReferences === null) return [];
  if (!Array.isArray(rawReferences)) {
    return [
      `${prefix}: body.references must be an array of { path, assumption } objects when present, got ${typeof rawReferences}.`,
    ];
  }
  const errors = [];
  for (const entry of rawReferences) {
    if (!isObjectPathEntry(entry)) {
      errors.push(
        `${prefix}: body.references entry must declare { path: <string>, assumption: one of ${FILE_ASSUMPTION_VALUES.join('|')} }. Got: ${JSON.stringify(entry)}.`,
      );
    }
  }
  return errors;
}

/**
 * @param {string} prefix
 * @param {unknown} rawAcceptance
 * @returns {string[]}
 */
function collectAcceptanceErrors(prefix, rawAcceptance) {
  const acceptance = Array.isArray(rawAcceptance) ? rawAcceptance : [];
  if (acceptance.length === 0) {
    return [
      `${prefix}: acceptance must list at least one criterion — author it at the ticket's top level (preferred) or in the body's ## Acceptance section.`,
    ];
  }
  return [];
}

/**
 * @param {string} prefix
 * @param {unknown} rawVerify
 * @returns {string[]}
 */
/**
 * @param {object[]} tickets
 * @returns {string[]}
 */
export function collectTaskBodyErrors(tickets) {
  const errors = [];
  for (const ticket of tickets) {
    if (shouldSkipTicket(ticket)) continue;
    errors.push(...validateTaskBodyShape(ticket));
  }
  return errors;
}

/**
 * @param {object[]} tickets
 * @returns {object[]}
 */
export function validateTaskBodies(tickets) {
  const errs = collectTaskBodyErrors(tickets);
  if (errs.length === 0) return tickets;
  throw new Error(
    `[Decomposer] ${errs.length} story body schema violation(s):\n${errs.map((e) => `  - ${e}`).join('\n')}`,
  );
}
