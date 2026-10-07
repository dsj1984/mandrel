/**
 * audit-exceptions.js — reviewed, dated exceptions for the SCA gate.
 *
 * Some advisories have no patched release at all, so no lockfile refresh or
 * `overrides` pin can clear them, and a bare `npm audit --audit-level=high`
 * stays red on `main` until upstream ships, blocking every unrelated PR.
 * `.agents/rules/security-baseline.md` § Dependency Hygiene allows a deferred
 * finding exactly when it is unreachable in production and documented with a
 * review date. This module is the mechanical half of that allowance: it
 * decides which advisories a committed `audit-exceptions.json` may suppress.
 *
 * An exception is honored only when ALL of these hold:
 *   (a) an advisory in the full-tree audit carries its GHSA id and package;
 *   (b) the same advisory is absent from the `--omit=dev` audit — no
 *       production path reaches it. This is checked, never taken from the
 *       entry's `reason` prose;
 *   (c) today (UTC) is on or before its `reviewBy` date.
 *
 * An exception failing (b) or (c) suppresses nothing, so its advisory keeps
 * blocking with the failed condition named. An exception failing (a) is
 * stale and fails the gate on its own, so an entry cannot outlive the fix
 * that made it unnecessary.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import {
  extractBlockingAdvisories,
  isBlockingSeverity,
  runAuditReport,
} from './audit-advisories.js';

/** The committed exceptions file, at the repository root. */
export const EXCEPTIONS_FILE = 'audit-exceptions.json';

/** The four states an exception can be in after evaluation. */
export const HONORED = 'honored';
export const STALE = 'stale';
const REACHABLE_IN_PRODUCTION = 'reachable in production';
export const EXPIRED = 'expired';

const GHSA_PATTERN = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exceptions'],
  properties: {
    exceptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'package', 'reason', 'reviewBy'],
        properties: {
          id: {
            type: 'string',
            pattern: '^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$',
          },
          package: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
          reviewBy: { type: 'string', format: 'date' },
        },
      },
    },
  },
};

let validator = null;
function validate(data) {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    validator = ajv.compile(SCHEMA);
  }
  return validator(data) ? null : formatAjvErrors(validator.errors);
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message}`)
    .join('; ');
}

/**
 * Read and validate `audit-exceptions.json` from `dir`.
 *
 * A missing file means no exceptions. A file that exists but does not parse
 * or validate throws: the gate must fail closed, so a typo can never quietly
 * disable the audit.
 *
 * @param {string} dir
 * @param {{ readFile?: Function }} [deps]
 * @returns {Array<{ id: string, package: string, reason: string, reviewBy: string }>}
 */
export function loadExceptions(dir, { readFile = readFileSync } = {}) {
  const file = path.join(dir, EXCEPTIONS_FILE);
  let raw;
  try {
    raw = readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${EXCEPTIONS_FILE} is not valid JSON: ${err.message}`);
  }
  const problems = validate(data);
  if (problems) {
    throw new Error(`${EXCEPTIONS_FILE} failed validation: ${problems}`);
  }
  const seen = new Set();
  for (const { id } of data.exceptions) {
    if (seen.has(id)) {
      throw new Error(`${EXCEPTIONS_FILE} lists ${id} more than once`);
    }
    seen.add(id);
  }
  return data.exceptions;
}

/** Today's date as `YYYY-MM-DD` in UTC, so every runner agrees on it. */
function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function ghsaOf(via) {
  const match =
    typeof via?.url === 'string' ? via.url.match(GHSA_PATTERN) : null;
  return match ? match[0] : null;
}

function viaList(entry) {
  return Array.isArray(entry?.via) ? entry.via : [];
}

/**
 * Every blocking advisory object in a report, keyed by GHSA id.
 *
 * @param {object|null} report
 * @returns {Map<string, { id: string, package: string, source: unknown }>}
 */
function blockingRoots(report) {
  const roots = new Map();
  for (const entry of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of viaList(entry)) {
      const id = typeof via === 'object' ? ghsaOf(via) : null;
      if (id && isBlockingSeverity(via.severity ?? entry.severity)) {
        roots.set(id, { id, package: via.name, source: via.source });
      }
    }
  }
  return roots;
}

/**
 * The blocking GHSA ids a vulnerable package reaches, following `via` names
 * through the transitive chain. An unresolvable chain yields an empty list,
 * which the caller reads as "cannot be suppressed".
 */
function reachedRoots(report, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const out = [];
  for (const via of viaList(report?.vulnerabilities?.[name])) {
    if (typeof via === 'string') {
      out.push(...reachedRoots(report, via, seen));
    } else if (isBlockingSeverity(via?.severity) && ghsaOf(via)) {
      out.push(ghsaOf(via));
    }
  }
  return out;
}

/**
 * The GHSA ids behind one projected advisory from
 * `extractBlockingAdvisories`: the advisory itself for an `advisory:` id, the
 * roots it transitively reaches for a `package:` id.
 */
function ghsaIdsFor(report, advisory, roots) {
  if (advisory.id.startsWith('package:')) {
    return reachedRoots(report, advisory.id.slice('package:'.length));
  }
  for (const root of roots.values()) {
    if (advisory.id === `advisory:${root.source}`) return [root.id];
  }
  const fromUrl = advisory.id.match(GHSA_PATTERN);
  return fromUrl ? [fromUrl[0]] : [];
}

function statusOf(exception, { roots, productionRoots, today }) {
  const root = roots.get(exception.id);
  if (!root || root.package !== exception.package) return STALE;
  if (productionRoots.has(exception.id)) return REACHABLE_IN_PRODUCTION;
  if (exception.reviewBy < today) return EXPIRED;
  return HONORED;
}

/**
 * Apply the exceptions to a pair of audit reports.
 *
 * Pure — the caller owns running the audits and reading the file.
 *
 * @param {{
 *   report: object,
 *   productionReport: object,
 *   exceptions: Array<object>,
 *   today: string,
 * }} input
 * @returns {{
 *   failed: boolean,
 *   advisories: Array<object>,
 *   suppressed: Array<object>,
 *   exceptions: Array<{ exception: object, status: string }>,
 * }} `advisories` are the blocking advisories still standing; `exceptions`
 *   carries each entry's evaluated status.
 */
function applyExceptions({ report, productionReport, exceptions, today }) {
  const roots = blockingRoots(report);
  const productionRoots = blockingRoots(productionReport);
  const evaluated = exceptions.map((exception) => ({
    exception,
    status: statusOf(exception, { roots, productionRoots, today }),
  }));
  const honored = new Set(
    evaluated.filter((e) => e.status === HONORED).map((e) => e.exception.id),
  );
  const advisories = [];
  const suppressed = [];
  for (const advisory of extractBlockingAdvisories(report)) {
    const ids = ghsaIdsFor(report, advisory, roots);
    const covered = ids.length > 0 && ids.every((id) => honored.has(id));
    (covered ? suppressed : advisories).push(advisory);
  }
  return {
    failed: advisories.length > 0 || evaluated.some((e) => e.status === STALE),
    advisories,
    suppressed,
    exceptions: evaluated,
  };
}

/**
 * Audit `dir` (full tree and production closure) and apply `exceptions`.
 *
 * @param {string} dir
 * @param {{ exceptions: Array<object>, today?: string, spawn?: Function }} options
 * @returns {ReturnType<typeof applyExceptions>}
 * @throws {Error} when npm could not evaluate the tree at all.
 */
export function auditWithExceptions(
  dir,
  { exceptions, today = todayUtc(), spawn } = {},
) {
  const deps = spawn ? { spawn } : {};
  return applyExceptions({
    report: runAuditReport(dir, deps),
    productionReport: runAuditReport(dir, { ...deps, omitDev: true }),
    exceptions,
    today,
  });
}
