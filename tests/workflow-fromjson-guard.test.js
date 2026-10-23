import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const WORKFLOWS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
);

// A step's `env:` is evaluated before its `if:`, so `fromJSON` over an
// output the step may not have set throws even when the step is skipped.
const STEP_FROMJSON = /fromJSON\(\s*(steps\.[\w-]+\.outputs\.[\w-]+)([^)]*)\)/g;

function findUnguardedStepFromJson(source) {
  const hits = [];
  source.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(STEP_FROMJSON)) {
      if (!m[2].includes('||')) hits.push({ line: i + 1, expr: m[0] });
    }
  });
  return hits;
}

test('the guard flags an unguarded fromJSON over a step output', () => {
  const unguarded =
    '        env:\n          B: fromJSON(steps.release.outputs.pr).headBranchName';
  assert.deepEqual(findUnguardedStepFromJson(unguarded), [
    { line: 2, expr: 'fromJSON(steps.release.outputs.pr)' },
  ]);
  const guarded =
    "          B: fromJSON(steps.release.outputs.pr || '{}').headBranchName";
  assert.deepEqual(findUnguardedStepFromJson(guarded), []);
  assert.deepEqual(
    findUnguardedStepFromJson('fromJSON(needs.a.outputs.b)'),
    [],
  );
});

test('no workflow parses a step output with fromJSON without a fallback', () => {
  const offenders = readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) =>
      findUnguardedStepFromJson(readFileSync(join(WORKFLOWS, f), 'utf8')).map(
        (h) => `${f}:${h.line} ${h.expr}`,
      ),
    );
  assert.deepEqual(offenders, []);
});

test('the release PR LOC-row steps can never fail the job npm-publish needs', () => {
  const wf = load(readFileSync(join(WORKFLOWS, 'release-please.yml'), 'utf8'));
  assert.ok(wf.jobs['npm-publish'].needs.includes('release-please'));
  const locSteps = wf.jobs['release-please'].steps.filter((s) =>
    String(s.if ?? '').includes('steps.release.outputs.prs_created'),
  );
  assert.equal(locSteps.length, 3);
  for (const step of locSteps) {
    assert.equal(step['continue-on-error'], true, step.name);
  }
});
