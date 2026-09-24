/**
 * Router contract guards for the unified `/mandrel-deliver` workflow prose.
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
const DELIVER_MD = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'mandrel-deliver.md',
);
const DELIVER_STORY_MD = path.join(
  REPO_ROOT,
  '.agents',
  'workflows',
  'helpers',
  'deliver-story.md',
);

describe('unified /mandrel-deliver router', () => {
  it('routes every Story through helpers/deliver-story.md', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(
      md,
      /helpers\/deliver-story\.md/,
      'router must name the unified Story helper',
    );
    assert.doesNotMatch(md, /deliver-epic-single\.md|deliver-epic\.md/);
  });

  it('hard-errors on wrong-typed tickets', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    // Story #5139 widened the accepted type set to {story, epic} — an Epic id
    // expands to its children. Story #5341 then dropped the `Epic: #N` footer
    // sentence from the router prose: the refusal itself is unchanged and
    // still enforced by `resolve-stories.js`, which is where it is now stated
    // once instead of in seven documents that had already begun to disagree.
    assertDocMentions(
      md,
      /neither `type::story` nor `type::epic`/,
      'must name the accepted type set it refuses outside of',
    );
    assertDocMentions(md, /hard error/, 'refusal must be a hard error');
    assertDocOmits(
      md,
      /Epic: #N/,
      'the v1 footer refusal belongs to resolve-stories.js alone (#5341)',
    );
  });

  it('documents the container-Epic expansion as an input shape', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assertDocMentions(
      md,
      /`type::epic`/,
      'the Inputs table must carry the Epic-id shape',
    );
    assertDocMentions(
      md,
      /open.{0,40}child Stories|child Stories/i,
      'must say an Epic resolves to its OPEN children',
    );
  });

  it('the Story helper documents the direct PR-to-main branch model', () => {
    const md = readFileSync(DELIVER_STORY_MD, 'utf8');
    assert.match(md, /type::story/);
    assertDocMentions(
      md,
      /PR against main|PR to `main`|Merge target \| `main`/,
      'the helper must document the direct PR-to-main merge target',
    );
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
    // The guard is structural, not a phrase count: the Epic-era helper and
    // the wave merge must not reappear. It used to be paired with a positive
    // assertion that the doc *said* "no `epic/<id>` branch, no `--no-ff` wave
    // merge" — but that sentence taught the reader an absence, spending
    // resident context describing a model no v2 reader can reach. The
    // omission guard below is what actually fences the regression; the
    // positive branch model is asserted in the sibling test above.
    assertDocOmits(
      md,
      /helpers\/deliver-epic|git merge --no-ff|epic\/<id> (branch|integration branch)/,
      'the Epic-era helper, wave merge, and integration branch must not reappear',
    );
  });

  it('sequences N>1 via resolve-stories + deliver-run + the epilogue', () => {
    // Story #5345 moved the beat behind `deliver-run.js`: the doc names the
    // resolver, the beat and the epilogue, and no longer names the tick the
    // beat wraps — driving a run from the tick directly reopens the init
    // window the run ledger closes.
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(md, /resolve-stories\.js/);
    assert.match(md, /deliver-run\.js/);
    assert.match(md, /plan-run-epilogue\.js/);
    assertDocOmits(
      md,
      /stories-wave-tick\.js/,
      'the multi-Story run goes through deliver-run.js, not the tick underneath it',
    );
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
      /deliver-run\.js \\\n\s*--stories <id,id,\.\.\.>[^\n]*/,
    );
    assert.ok(commandTemplate, 'the beat command template must be present');
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

describe('/mandrel-deliver takes only Story ids (Story #4540)', () => {
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
    // envelope". That prose existed because planReadySet satisfies a
    // foreign gate only via the done set, so a host that seeded it empty
    // silently discarded the cross-run resolution and wedged the run.
    //
    // Probe mode retires the instruction rather than restating it: the tick
    // resolves the graph and derives done / in-flight itself, every beat, so
    // there is no seed to get wrong. The invariant is now enforced by
    // `lib/wave-runner/live-probe.js` (and pinned in
    // tests/wave-runner/live-probe.test.js) instead of by operator prose.
    //
    // Story #5345 took the last hand-maintained flag out too: `--dispatched`
    // is now the run ledger `deliver-run.js` keeps for itself, so the beat
    // command carries only the id set and the hand-offs.
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(md, /deliver-run\.js \\\n\s*--stories <id,id,\.\.\.>/);
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
    assertDocOmits(
      md,
      /--dispatched/,
      'the dispatched list is the run ledger, never the operator’s bookkeeping',
    );
  });

  it('documents the wedged verdict as distinct from waiting and from a cycle', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assert.match(md, /wedged/);
    assert.match(md, /cycleError/);
  });
});

describe('multi-Story order and Slicing resume (Story #5427)', () => {
  it('announces a multi-Story order and proceeds, while a bare invocation still asks', () => {
    const md = readFileSync(DELIVER_MD, 'utf8');
    assertDocMentions(
      md,
      /Present the resolved order and proceed — do not wait for confirmation/,
      'step 2 must present the order and continue',
    );
    assertDocOmits(
      md,
      /Present the order; wait unless `--yes`/,
      'the confirmation wait must be gone',
    );
    assertDocMentions(
      md,
      /List the open `agent::ready` Stories and ask which to deliver/,
      'a bare invocation must still ask',
    );
  });

  it('deliver-story Step 1 re-derives Slicing progress from git log after a context summary', () => {
    const md = readFileSync(DELIVER_STORY_MD, 'utf8');
    assertDocMentions(
      md,
      /After a context summary, re-derive progress from `git log` on `story-<id>` against the `## Slicing` rows/,
      'Step 1 must name the post-summary re-derive',
    );
  });
});
