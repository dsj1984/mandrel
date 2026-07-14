import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPlanRunEnvelope,
  normalizePlanRunLabel,
  resolvePlanRunFromIssues,
} from '../.agents/scripts/resolve-plan-run.js';

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
    assert.match(md, /not `type::story`/);
    assert.match(md, /Epic: #N/);
    assert.match(md, /hard error/);
  });

  it('the Story helper documents the direct PR-to-main branch model', () => {
    const md = readFileSync(DELIVER_STORY_MD, 'utf8');
    assert.match(md, /type::story/);
    assert.match(md, /PR against main|PR to `main`|Merge target \| `main`/);
    assert.match(md, /no `epic\/<id>`/i);
  });
});

describe('resolve-plan-run envelope', () => {
  it('normalizes run ids and filters to Story tickets', () => {
    const issues = [
      {
        number: 103,
        title: 'later',
        labels: ['type::story', 'plan-run::abc'],
        body: 'blocked by #101',
      },
      { number: 102, title: 'epic', labels: ['type::epic'], body: '' },
      {
        number: 101,
        title: 'first',
        labels: [{ name: 'type::story' }, { name: 'plan-run::abc' }],
        body: '',
      },
    ];

    const envelope = resolvePlanRunFromIssues({ run: 'plan-run::ABC', issues });

    assert.equal(normalizePlanRunLabel('ABC'), 'plan-run::abc');
    assert.equal(envelope.kind, 'plan-run');
    assert.deepEqual(
      envelope.stories.map((story) => story.id),
      [101, 103],
    );
    assert.deepEqual(envelope.dag, [
      { id: 101, dependsOn: [] },
      { id: 103, dependsOn: [101] },
    ]);
  });

  it('builds an empty Story set without throwing when no type::story matches', () => {
    const envelope = buildPlanRunEnvelope(
      [{ number: 1, labels: ['type::epic'], body: '' }],
      { planRunId: 'empty', planRunLabel: 'plan-run::empty' },
    );
    assert.deepEqual(envelope.stories, []);
    assert.deepEqual(envelope.dag, []);
  });
});
