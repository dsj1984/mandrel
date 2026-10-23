#!/usr/bin/env node

/**
 * CLI: required-status-check drift between the committed ruleset snapshot
 * (`.github/ruleset.json`) and the live `main` branch rules. The snapshot is
 * not enforcement, so a context added to CI and the snapshot but never to the
 * live ruleset silently stops gating merges (Story #5866).
 *
 * Exit codes: 0 = the context sets match; 1 = they differ.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileCapture } from '../.agents/scripts/lib/child-exec.js';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = path.join(ROOT, '.github', 'ruleset.json');

export const USAGE = `Usage: node scripts/check-ruleset-drift.js

Compare the required status checks in .github/ruleset.json with the live
rules on \`main\` (\`gh api repos/{owner}/{repo}/rules/branches/main\`) and
print every context present on one side only.

Exits 0 when the sets match, 1 when they differ.
`;

/** Contexts of every `required_status_checks` rule in a rule list. */
export function requiredContexts(rules) {
  return new Set(
    rules
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context),
  );
}

export function diffContexts(snapshot, live) {
  return {
    snapshotOnly: [...snapshot].filter((c) => !live.has(c)).sort(),
    liveOnly: [...live].filter((c) => !snapshot.has(c)).sort(),
  };
}

function fetchLiveRules() {
  return JSON.parse(
    execFileCapture('gh', ['api', 'repos/{owner}/{repo}/rules/branches/main']),
  );
}

export function checkRulesetDrift({
  snapshotPath = SNAPSHOT,
  fetchLive = fetchLiveRules,
  stdout = process.stdout,
} = {}) {
  const snapshot = requiredContexts(
    JSON.parse(readFileSync(snapshotPath, 'utf8')).rules,
  );
  const { snapshotOnly, liveOnly } = diffContexts(
    snapshot,
    requiredContexts(fetchLive()),
  );
  for (const context of snapshotOnly) {
    stdout.write(`[ruleset-drift] snapshot only (not enforced): ${context}\n`);
  }
  for (const context of liveOnly) {
    stdout.write(
      `[ruleset-drift] live only (missing from snapshot): ${context}\n`,
    );
  }
  const drift = snapshotOnly.length + liveOnly.length;
  stdout.write(
    `[ruleset-drift] contexts=${snapshot.size} drift=${drift} (${drift ? 'fail' : 'ok'})\n`,
  );
  return drift ? 1 : 0;
}

runAsCli(import.meta.url, async () => checkRulesetDrift(), {
  source: 'ruleset-drift',
  propagateExitCode: true,
  usage: USAGE,
});
