/**
 * tests/scripts/spec-renderer.test.js — Story #1495 / Task #1524,
 * rewritten under Epic #3163 / Story #3192 for the 3-tier shape.
 *
 * Verifies `lib/orchestration/spec-renderer.js`'s projection of the
 * decomposer's flat ticket array shape into the structural spec
 * `.agents/schemas/epic-spec.schema.json` consumes. The round-trip
 * property — `parse → render → write → loadSpec → equal` — is the
 * canonical AC: anything the renderer writes must be parseable by the
 * spec-loader and structurally identical on reload.
 *
 * Under the 3-tier hierarchy (Epic #3078), Stories have no Task
 * children — `acceptance[]` / `verify[]` arrays live inline on the
 * Story. The renderer's previous Task emission code path (the
 * `tasks: [...]` array on each Story) has been deleted in Story #3192.
 * The decomposer never emits `type: 'task'`, and the renderer now
 * raises immediately if such a ticket appears.
 *
 * Coverage:
 *   - Hierarchy walk preserves feature/story ordering and slugs.
 *   - Inter-Story `depends_on` edges round-trip as `dependsOn` (slug to
 *     slug, no GH issue numbers leaking through).
 *   - Wave layering matches the depth in the story-only DAG, so
 *     `wave: 0` Stories are the roots.
 *   - Labels round-trip verbatim except for `agent::*`, which the
 *     renderer strips (the schema forbids them).
 *   - Inline `acceptance[]` / `verify[]` arrays (top-level on the
 *     Story ticket, or nested under a structured `body`) project
 *     onto the rendered Story.
 *   - A `type: 'task'` ticket raises immediately (3-tier guard).
 *   - Schema-invalid inputs raise `SpecRenderValidationError`.
 *   - Gates are passed through verbatim when provided.
 *
 * The round-trip uses `js-yaml` directly to write the rendered spec to
 * a sandbox dir, then `loadSpec` from the spec module to verify the
 * reload. This is the strictest possible check: if the loader rejects
 * the renderer's output, the test fails on the loader's error rather
 * than swallowing it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import yaml from 'js-yaml';

import {
  _resetRendererValidatorCacheForTests,
  renderSpec,
  SpecRenderValidationError,
} from '../../.agents/scripts/lib/orchestration/spec-renderer.js';
import { loadSpec } from '../../.agents/scripts/lib/spec/index.js';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'spec-renderer-'));
  _resetRendererValidatorCacheForTests();
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function plantSpec(epicId, specObject) {
  const target = path.join(sandbox, `${epicId}.yaml`);
  writeFileSync(target, yaml.dump(specObject), 'utf8');
  return target;
}

/**
 * Minimal valid ticket-array fixture covering two Features and three
 * Stories — one with inter-Story deps, one with an `agent::*` label
 * that must be stripped, and one with a structured body object that
 * carries nested `acceptance` / `verify` arrays. The fixture also
 * exercises the top-level vs body-nested precedence for the inline
 * arrays.
 */
function buildFixtureTickets() {
  return [
    {
      slug: 'spec-and-schema',
      type: 'feature',
      title: 'Spec format + JSON Schema',
      body: 'Spec format milestone.',
      labels: ['type::feature'],
      parent_slug: '',
      depends_on: [],
    },
    {
      slug: 'schema-author',
      type: 'story',
      title: 'Author epic-spec.schema.json',
      body: 'Define the canonical structural schema.',
      labels: ['type::story', 'persona::architect', 'agent::done'],
      parent_slug: 'spec-and-schema',
      depends_on: [],
      acceptance: ['Schema parses as JSON', 'Top-level required keys set'],
      verify: ['node --test tests/scripts/epic-spec-schema.test.js'],
    },
    {
      slug: 'reconciler-core',
      type: 'feature',
      title: 'Reconciler diff + apply',
      labels: ['type::feature'],
      parent_slug: '',
      depends_on: [],
    },
    {
      slug: 'diff-engine',
      type: 'story',
      title: 'Diff engine + drift discriminator',
      // Structured body to exercise the legacy nested-body path for
      // inline acceptance/verify; the body itself renders to the
      // Goal/Changes/Acceptance/Verify markdown projection.
      body: {
        goal: 'Implement the pure diff for the spec reconciler.',
        changes: ['lib/spec/diff.js: implement'],
        acceptance: ['diff is pure (no I/O)'],
        verify: ['npm test (unit)'],
      },
      labels: ['type::story', 'persona::engineer'],
      parent_slug: 'reconciler-core',
      depends_on: ['schema-author'],
    },
    {
      slug: 'apply-engine',
      type: 'story',
      title: 'Apply engine',
      body: 'Mutator side.',
      labels: ['type::story'],
      parent_slug: 'reconciler-core',
      depends_on: ['diff-engine'],
      acceptance: ['runner is testable'],
      verify: ['npm test (unit)'],
    },
  ];
}

const FIXTURE_EPIC = {
  id: 1182,
  title: 'v6 Epic D — Declarative epic.yaml + reconciler',
  body: 'Structural SSOT migration.',
  labels: ['type::epic', 'agent::executing'],
};

describe('lib/orchestration/spec-renderer.js — basic projection', () => {
  it('returns a valid spec with the expected top-level shape', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    assert.equal(spec.epic.id, 1182);
    assert.equal(
      spec.epic.title,
      'v6 Epic D — Declarative epic.yaml + reconciler',
    );
    assert.deepEqual(spec.epic.labels, ['type::epic']); // agent::* stripped
    assert.equal(spec.features.length, 2);
    assert.deepEqual(
      spec.features.map((f) => f.slug),
      ['spec-and-schema', 'reconciler-core'],
    );
  });

  it('preserves Story slugs under the correct Feature', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const feature = spec.features.find((f) => f.slug === 'spec-and-schema');
    assert.ok(feature, 'feature spec-and-schema present');
    assert.equal(feature.stories.length, 1);
    const story = feature.stories[0];
    assert.equal(story.slug, 'schema-author');
  });

  it('never emits a `tasks` key on any Story (3-tier shape)', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    for (const f of spec.features) {
      for (const s of f.stories) {
        assert.equal(
          Object.hasOwn(s, 'tasks'),
          false,
          `Story ${s.slug} must not carry a tasks[] key under the 3-tier shape`,
        );
      }
    }
  });

  it('strips agent::* labels from every entity', () => {
    const tickets = buildFixtureTickets();
    // The fixture intentionally seeds an agent::done on the
    // schema-author Story and agent::executing on the Epic.
    const spec = renderSpec(tickets, { epic: FIXTURE_EPIC });
    const story = spec.features[0].stories[0];
    assert.ok(
      !story.labels?.some((l) => l.startsWith('agent::')),
      'no agent::* labels on Story',
    );
    assert.ok(
      !spec.epic.labels?.some((l) => l.startsWith('agent::')),
      'no agent::* labels on Epic',
    );
  });

  it('projects top-level inline acceptance/verify onto the Story', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const story = spec.features[0].stories[0];
    assert.deepEqual(story.acceptance, [
      'Schema parses as JSON',
      'Top-level required keys set',
    ]);
    assert.deepEqual(story.verify, [
      'node --test tests/scripts/epic-spec-schema.test.js',
    ]);
  });

  it('falls back to body-nested acceptance/verify when no top-level fields', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const diffEngine = spec.features
      .find((f) => f.slug === 'reconciler-core')
      .stories.find((s) => s.slug === 'diff-engine');
    assert.deepEqual(diffEngine.acceptance, ['diff is pure (no I/O)']);
    assert.deepEqual(diffEngine.verify, ['npm test (unit)']);
  });

  it('renders structured Story bodies into the markdown projection', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const diffEngine = spec.features
      .find((f) => f.slug === 'reconciler-core')
      .stories.find((s) => s.slug === 'diff-engine');
    assert.ok(diffEngine.body, 'Story body present');
    assert.match(diffEngine.body, /## Goal/);
    assert.match(diffEngine.body, /## Changes/);
    assert.match(diffEngine.body, /## Acceptance/);
    assert.match(diffEngine.body, /## Verify/);
    assert.match(diffEngine.body, /Implement the pure diff/);
  });

  it('passes through gates when provided', () => {
    const spec = renderSpec(buildFixtureTickets(), {
      epic: FIXTURE_EPIC,
      gates: { baseline: 'ratchet-2026-05-12', config: 'gate-config-v6' },
    });
    assert.deepEqual(spec.gates, {
      baseline: 'ratchet-2026-05-12',
      config: 'gate-config-v6',
    });
  });
});

describe('lib/orchestration/spec-renderer.js — dependsOn / wave layering', () => {
  it('projects inter-Story depends_on edges as dependsOn (slug to slug)', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const diffEngine = spec.features
      .find((f) => f.slug === 'reconciler-core')
      .stories.find((s) => s.slug === 'diff-engine');
    assert.deepEqual(diffEngine.dependsOn, ['schema-author']);
  });

  it('assigns wave 0 to Stories with no inbound edges', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const schemaAuthor = spec.features[0].stories[0];
    assert.equal(schemaAuthor.wave, 0);
  });

  it('layers Stories by DAG depth (wave === max(depDepths) + 1)', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const stories = new Map();
    for (const f of spec.features) {
      for (const s of f.stories) stories.set(s.slug, s);
    }
    assert.equal(stories.get('schema-author').wave, 0);
    assert.equal(stories.get('diff-engine').wave, 1);
    assert.equal(stories.get('apply-engine').wave, 2);
  });

  it('drops self-references and edges to foreign slugs', () => {
    const tickets = buildFixtureTickets();
    // Inject a self-edge + a foreign-slug edge on diff-engine.
    const diffEngine = tickets.find((t) => t.slug === 'diff-engine');
    diffEngine.depends_on = [
      ...diffEngine.depends_on,
      'diff-engine',
      'does-not-exist',
    ];
    const spec = renderSpec(tickets, { epic: FIXTURE_EPIC });
    const projected = spec.features
      .find((f) => f.slug === 'reconciler-core')
      .stories.find((s) => s.slug === 'diff-engine');
    assert.deepEqual(projected.dependsOn, ['schema-author']);
  });

  it('omits dependsOn when no real inter-Story edges exist', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    const schemaAuthor = spec.features[0].stories[0];
    assert.equal(schemaAuthor.dependsOn, undefined);
  });
});

describe('lib/orchestration/spec-renderer.js — 3-tier guard', () => {
  it('rejects a ticket of type "task" with a 3-tier message', () => {
    const tickets = buildFixtureTickets();
    tickets.push({
      slug: 'orphan-task',
      type: 'task',
      title: 'Should not be accepted',
      parent_slug: 'schema-author',
      depends_on: [],
    });
    assert.throws(
      () => renderSpec(tickets, { epic: FIXTURE_EPIC }),
      /3-tier hierarchy/,
    );
  });
});

describe('lib/orchestration/spec-renderer.js — schema validation', () => {
  it('raises SpecRenderValidationError when the projection is invalid', () => {
    const tickets = buildFixtureTickets();
    // Force an invalid slug on a Story — the schema's slug pattern
    // requires kebab-case starting with [a-z0-9].
    const story = tickets.find((t) => t.slug === 'apply-engine');
    story.slug = 'Invalid Slug!';
    // Re-point the dependent edge so the validator does not raise an
    // unrelated "unknown dep" error first.
    story.depends_on = [];
    assert.throws(
      () => renderSpec(tickets, { epic: FIXTURE_EPIC }),
      SpecRenderValidationError,
    );
  });

  it('skips validation when opts.validate === false', () => {
    const tickets = buildFixtureTickets();
    const story = tickets.find((t) => t.slug === 'apply-engine');
    story.slug = 'Invalid Slug!';
    story.depends_on = [];
    const spec = renderSpec(tickets, {
      epic: FIXTURE_EPIC,
      validate: false,
    });
    // The invalid slug survives because validation was skipped.
    const projected = spec.features
      .find((f) => f.slug === 'reconciler-core')
      .stories.find((s) => s.slug === 'Invalid Slug!');
    assert.ok(projected, 'invalid-slug Story present in unvalidated output');
  });

  it('rejects non-array tickets', () => {
    assert.throws(
      () => renderSpec({ not: 'an array' }, { epic: FIXTURE_EPIC }),
      TypeError,
    );
  });

  it('rejects missing opts.epic', () => {
    assert.throws(() => renderSpec([], {}), TypeError);
  });
});

describe('lib/orchestration/spec-renderer.js — round-trip via loader', () => {
  it('renders a spec the loader accepts as valid', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    plantSpec(FIXTURE_EPIC.id, spec);
    const reloaded = loadSpec(FIXTURE_EPIC.id, { epicsDir: sandbox });
    assert.equal(reloaded.epic.id, FIXTURE_EPIC.id);
    assert.equal(reloaded.features.length, spec.features.length);
  });

  it('round-trip preserves slugs and hierarchy exactly', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    plantSpec(FIXTURE_EPIC.id, spec);
    const reloaded = loadSpec(FIXTURE_EPIC.id, { epicsDir: sandbox });

    const flatten = (s) =>
      s.features.flatMap((f) =>
        f.stories.map((st) => ({
          kind: 'story',
          slug: st.slug,
          parent: f.slug,
        })),
      );

    assert.deepEqual(flatten(reloaded), flatten(spec));
  });

  it('round-trip preserves dependsOn edges verbatim', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    plantSpec(FIXTURE_EPIC.id, spec);
    const reloaded = loadSpec(FIXTURE_EPIC.id, { epicsDir: sandbox });

    const findStory = (root, slug) =>
      root.features.flatMap((f) => f.stories).find((s) => s.slug === slug);

    const original = findStory(spec, 'diff-engine');
    const reread = findStory(reloaded, 'diff-engine');
    assert.deepEqual(reread.dependsOn, original.dependsOn);
    assert.deepEqual(reread.dependsOn, ['schema-author']);

    const apply = findStory(reloaded, 'apply-engine');
    assert.deepEqual(apply.dependsOn, ['diff-engine']);
  });

  it('round-trip preserves wave numbers', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    plantSpec(FIXTURE_EPIC.id, spec);
    const reloaded = loadSpec(FIXTURE_EPIC.id, { epicsDir: sandbox });

    const waves = new Map();
    for (const f of reloaded.features) {
      for (const s of f.stories) waves.set(s.slug, s.wave);
    }
    assert.equal(waves.get('schema-author'), 0);
    assert.equal(waves.get('diff-engine'), 1);
    assert.equal(waves.get('apply-engine'), 2);
  });

  it('round-trip preserves labels (modulo agent::* strip)', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    plantSpec(FIXTURE_EPIC.id, spec);
    const reloaded = loadSpec(FIXTURE_EPIC.id, { epicsDir: sandbox });

    const schemaAuthor = reloaded.features[0].stories[0];
    assert.deepEqual(schemaAuthor.labels, [
      'type::story',
      'persona::architect',
    ]);
    assert.ok(
      !schemaAuthor.labels.some((l) => l.startsWith('agent::')),
      'agent::* labels stripped',
    );
  });

  it('round-trip preserves inline acceptance/verify arrays', () => {
    const spec = renderSpec(buildFixtureTickets(), { epic: FIXTURE_EPIC });
    plantSpec(FIXTURE_EPIC.id, spec);
    const reloaded = loadSpec(FIXTURE_EPIC.id, { epicsDir: sandbox });

    const findStory = (root, slug) =>
      root.features.flatMap((f) => f.stories).find((s) => s.slug === slug);

    const schemaAuthor = findStory(reloaded, 'schema-author');
    assert.deepEqual(schemaAuthor.acceptance, [
      'Schema parses as JSON',
      'Top-level required keys set',
    ]);
    assert.deepEqual(schemaAuthor.verify, [
      'node --test tests/scripts/epic-spec-schema.test.js',
    ]);
  });
});
