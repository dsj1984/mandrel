/**
 * `validateOrchestrationConfig` — hand-written security checks for the
 * post-reshape config (Epic #1720 Story #1739).
 *
 * The structural validation now lives in the top-level AJV schema (run by
 * `resolveConfig` against the full `.agentrc.json` document). This module
 * carries the security checks that JSON Schema cannot express:
 *
 *   - Shell-metacharacter injection on `github.{owner, repo, operatorHandle}`.
 *   - Path-traversal containment on `delivery.worktreeIsolation.root`.
 *
 * Accepts either the full resolved config (`{ project, github, planning,
 * delivery }`) or `null` (zero-config callers — no checks needed).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHELL_INJECTION_RE_STRICT as SHELL_INJECTION_RE } from '../config-schema.js';
import { assertPathContainment } from '../path-security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/config/ → scripts/lib/ → scripts/ → .agents/ → project root
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Run the post-reshape security checks against a resolved config bag.
 *
 * @param {object|null} config - The resolved config (`{ project, github, ... }`)
 *   or `null` for zero-config callers.
 * @throws {Error} If any security check fails.
 */
export function validateOrchestrationConfig(config) {
  if (config == null) return;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(
      'Invalid configuration: expected an object with `github` and `delivery` blocks.',
    );
  }

  const errors = [];

  const github = config.github ?? null;
  const worktreeIsolation = config.delivery?.worktreeIsolation ?? null;

  if (github && typeof github === 'object') {
    for (const field of ['owner', 'repo', 'operatorHandle']) {
      const value = github[field];
      if (typeof value === 'string' && SHELL_INJECTION_RE.test(value)) {
        errors.push(
          `- [Security] Shell meta-characters detected in github.${field}.`,
        );
      }
    }
  }

  const wtRoot = worktreeIsolation?.root;
  if (typeof wtRoot === 'string') {
    if (SHELL_INJECTION_RE.test(wtRoot)) {
      errors.push(
        '- [Security] Shell meta-characters detected in delivery.worktreeIsolation.root.',
      );
    } else {
      try {
        assertPathContainment(
          PROJECT_ROOT,
          path.resolve(PROJECT_ROOT, wtRoot),
          'delivery.worktreeIsolation.root',
          { allowEmpty: false },
        );
      } catch {
        errors.push(
          `- [Security] delivery.worktreeIsolation.root resolves outside the repo root: ${wtRoot}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.join('\n')}`);
  }
}
