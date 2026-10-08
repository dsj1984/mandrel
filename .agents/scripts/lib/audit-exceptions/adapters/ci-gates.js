/**
 * CI gate exemptions in GitHub Actions workflows: `continue-on-error: true`
 * (a red job or step that cannot fail the run) and `if: false` (a gate switched
 * off outright). Read line by line so each record carries its real line.
 * `.agentrc.json` `ignoreGlobs` are deliberately not read here — the engine
 * delegates them to `/audit-baselines`, which owns dead ignore globs.
 *
 * @module lib/audit-exceptions/adapters/ci-gates
 */

import { readText } from '../read.js';
import { makeRecord } from '../record.js';

const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const SHAPES = Object.freeze([
  { re: /^\s*-?\s*continue-on-error:\s*true\b/, rule: 'continue-on-error' },
  {
    re: /^\s*-?\s*if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*(?:#|$)/,
    rule: 'if-false',
  },
]);

function reasonFor(lines, i) {
  const trailing = /#\s*(.*)$/.exec(lines[i])?.[1];
  if (trailing) return trailing;
  const prev = lines[i - 1]?.trim() ?? '';
  return prev.startsWith('#') ? prev.slice(1) : null;
}

function workflowRecords(ctx, file) {
  const lines = (readText(ctx.root, file) ?? '').split('\n');
  const records = [];
  lines.forEach((line, i) => {
    const shape = SHAPES.find((s) => s.re.test(line));
    if (!shape) return;
    records.push(
      makeRecord({
        adapter: 'ci-gates',
        category: 'gate',
        surface: 'github-actions',
        file,
        line: i + 1,
        target: shape.rule,
        rule: shape.rule,
        justification: reasonFor(lines, i),
        probe: { verdict: 'live', basis: 'setting-in-force' },
      }),
    );
  });
  return records;
}

export const ciGates = Object.freeze({
  id: 'ci-gates',
  category: 'gate',
  applies: (ctx) =>
    ctx.scope.files.some((f) => WORKFLOW_RE.test(f))
      ? { applies: true, reason: 'GitHub Actions workflows present' }
      : { applies: false, reason: 'no .github/workflows' },
  extract: (ctx) =>
    ctx.scope.files
      .filter((f) => WORKFLOW_RE.test(f))
      .flatMap((f) => workflowRecords(ctx, f)),
});
