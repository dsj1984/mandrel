/**
 * Router contract guards for the unified `/deliver` workflow prose.
 *
 * Story #4540 retired the `plan-run::<id>` label and the `--run` branch, so
 * the sequencing test and the envelope block here were re-pointed at
 * `resolve-stories.js`. The other guards in this file predate that change
 * and are deliberately retained: they fence v2-cutover regressions (no Epic
 * helper, no `epic/` wave merge, no Epic-era CLIs) that have nothing to do
 * with plan-run — and the `hard-errors on Epic-attached or non-Story
 * tickets` guard is the prose contract #4540's own resolver enforces.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertDocMentions, assertDocOmits } from './helpers/doc-assert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DELIVER_MD = path.join(REPO_ROOT, '.agents', 'workflows', 'deliver.md');
const DELIVER_STORY_MD = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'helpers',
  'deliver-story.md',
);

describe('unified /deliver router', () => {
  it('routes every Story through helpers/deliver-story.md', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(
      md,
      /helpers\/deliver-story\.md/,
      'router must name the unified Story helper',
    );
    assert.doesNotMatch(md, /deliver-epic-single\.md|deliver-epic\.md/);
  });

  it('hard-errors on Epic-attached or non-Story tickets', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assertDocMentions(md, /not `type::story`/, 'must name the refused type');
    assertDocMentions(md, /Epic: #N/, 'must name the v1 footer it refuses');
    assertDocMentions(md, /hard error/, 'refusal must be a hard error');
  });

  it('the Story helper documents the direct PR-to-main branch model', () => {
    const md = readFileSync(DELIVER_STORY_MD, 'utf8');
    assert.match(md, /type::story/);
    assertDocMentions(
      md,
      /PR against main|PR to `main`|Merge target \| `main`/,
      'the helper must document the direct PR-to-main merge target',
    );
    assertDocMentions(md, /no `epic\/<id>`/i, 'no Epic integration branch');
  });

  it('deliver-story stays on the single-story init/close path (no epic/ wave merge)', () => {
    const md = readFileSync(DELIVER_STORY_MD, 'utf8');
    assert.match(md, /single-story-init\.js/);
    assert.match(md, /single-story-close\.js/);
    assert.match(md, /ceremony-routing\.js/);
    // Reject the Epic-era CLIs; allow `single-story-init.js` /
    // `single-story-close.js` (the live v2 path until Stage 5 merges pairs).
    assert.doesNotMatch(md, /(?<!single-)story-init\.js/);
    assert.doesNotMatch(md, /(?<!single-)story-close\.js/);
    assertDocMentions(md, /no `--no-ff` wave merge/, 'no wave merge in v2');
    assertDocOmits(
      md,
      /helpers\/deliver-epic|git merge --no-ff/,
      'the Epic-era helper and wave merge must not reappear',
    );
  });

  it('sequences N>1 via resolve-stories + stories-wave-tick + the epilogue', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(md, /resolve-stories\.js/);
    assert.match(md, /stories-wave-tick\.js/);
    assert.match(md, /plan-run-epilogue\.js/);
    assertDocOmits(
      md,
      /resolveEpicDeliveryRoute|wave-tick\.js --check-idle/,
      'the Epic-era route resolver and idle check are retired',
    );
  });

  it('keeps --concurrency opt-in so a local override is not silently defeated', () => {
    // `resolveConcurrencyCap` returns the `--concurrency` flag before it ever
    // reads config, so any explicit value outranks
    // `delivery.deliverRunner.concurrencyCap` (including a `.agentrc.local.json`
    // override). The canonical sequencing command must therefore NOT hardcode
    // the flag — an executing agent that fills in `<n>` (typically the
    // documented default 3) would defeat the operator's configured cap.
    const md = readFileSync(DELIVER_MD, 'utf8');
    const commandTemplate = md.match(
      /stories-wave-tick\.js \\\n\s*--stories <id,id,\.\.\.> --probe-live[^\n]*/,
    );
    assert.ok(
      commandTemplate,
      'the sequencing command template must be present',
    );
    assert.doesNotMatch(
      commandTemplate[0],
      /--concurrency/,
      'the default sequencing command must not hardcode --concurrency',
    );
    // The opt-in contract must be spelled out so the flag is threaded through
    // only when the operator explicitly passed one.
    assertDocMentions(
      md,
      /Do not add `--concurrency` unless the operator explicitly asked/,
      'the opt-in contract for --concurrency must be spelled out',
    );
    assert.match(md, /\.agentrc\.local\.json/);
  });
});

describe('/deliver takes only Story ids (Story #4540)', () => {
  it('documents no --run, --dep, or hand-built DAG', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    // The retirement note may name them; the invocation surface may not.
    const withoutTombstone = md.replace(
      /> \*\*Retired \(Story #4540\)\.\*\*[\s\S]*?\n\n/,
      '',
    );
    assertDocOmits(
      withoutTombstone,
      /`--run <planRunId>`|\| `--run`|--dep <from>/,
      'the ids-only entry point must not advertise --run or --dep',
    );
    assert.doesNotMatch(
      withoutTombstone,
      /resolve-plan-run\.js/,
      'the label resolver is deleted',
    );
  });

  it('never instructs the host to read depends_on from bodies by hand', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assertDocOmits(
      md,
      /read `depends_on` \/ `blocked by` from each body/,
      'the graph is resolved from live state, not transcribed by the host',
    );
    assertDocMentions(
      md,
      /discovered, not declared|resolved.*from live state/i,
      'the doc must say the graph is discovered from live state',
    );
  });

  it('drives the beat from live state rather than hand-maintained flags (Story #4594)', () => {
    // Was: "mandates seeding the first beat --done from the resolver
    // envelope". That prose existed because selectReadySet satisfies a
    // foreign gate only via the done set, so a host that seeded it empty
    // silently discarded the cross-run resolution and wedged the run.
    //
    // Probe mode retires the instruction rather than restating it: the tick
    // resolves the graph and derives done / in-flight itself, every beat, so
    // there is no seed to get wrong. The invariant is now enforced by
    // `lib/wave-runner/live-probe.js` (and pinned in
    // tests/wave-runner/live-probe.test.js) instead of by operator prose.
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(md, /--stories <id,id,\.\.\.> --probe-live/);
    assertDocOmits(
      md,
      /Seed the first beat/,
      'the seed footgun is structurally impossible — it must not be re-documented',
    );
    assertDocOmits(
      md,
      /--done <csv> --in-flight <n>/,
      'the loop must not ask the host to maintain done / in-flight by hand',
    );
  });

  it('documents the wedged verdict as distinct from waiting and from a cycle', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(md, /wedged/);
    assert.match(md, /cycleError/);
  });
});
