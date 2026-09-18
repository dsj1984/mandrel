/**
 * Security checks JSON Schema cannot express: shell metacharacters in
 * `github.{owner, repo, operatorHandle}` and path containment of
 * `delivery.worktreeIsolation.root`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHELL_INJECTION_RE_STRICT as SHELL_INJECTION_RE } from '../config-schema.js';
import { assertPathContainment } from '../path-security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/config/ → scripts/lib/ → scripts/ → .agents/ → project root
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');

/**
 * @param {object|null} config - `null` for zero-config callers.
 * @throws {Error}
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
