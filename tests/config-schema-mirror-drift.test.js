import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildArtifacts,
  buildMirrorSchema,
  canonicalJson,
} from '../.agents/scripts/generate-config-docs.js';
import {
  BASELINE_SCHEMA_FILES,
  BASELINE_SCHEMAS_DIR,
  buildBaselineSchemaAjv,
} from '../.agents/scripts/lib/config-schema-shared.js';
import { AGENTRC_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';
import { createAjv, createAjv2020 } from '../.agents/scripts/lib/util/ajv.js';

// ---------------------------------------------------------------------------
// Generator-fidelity test (Story #5007), replacing the hand-parity drift test.
//
// Until #5007 `.agents/schemas/agentrc.schema.json` was a hand-maintained
// 60KB copy of the runtime AJV schema, and ~900 lines here sampled config
// documents through both validators to prove the copy had not drifted. The
// mirror is now a serialization of `AGENTRC_SCHEMA` emitted by
// `generate-config-docs.js`, so the drift class is structurally gone and what
// is left to prove is narrower and stronger:
//
//   1. The on-disk artifacts match what the generator emits right now.
//   2. Generation is deterministic (two runs, identical bytes).
//   3. The emitted mirror still compiles as JSON Schema 2020-12 — the dialect
//      every consumer editor resolves it under — and still agrees with the
//      runtime draft-07 validator on real documents. Serializing one object
//      into two dialects is where a genuine divergence could still hide.
//   4. The generator FAILS on injected drift, so a green run means "checked",
//      not "the comparator is inert".
//
// The `--check` mode asserted here is wired into `npm run docs:check`, hence
// `npm run lint`, hence the `lint` required check on every PR.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIRROR_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'schemas',
  'agentrc.schema.json',
);
const REFERENCE_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'docs',
  'agentrc-reference.json',
);

const mirror = JSON.parse(readFileSync(MIRROR_PATH, 'utf8'));

const ajv2020 = createAjv2020({ allErrors: true });
const mirrorValidator = ajv2020.compile(mirror);

const runtimeAjv = createAjv({ allErrors: true });
const runtimeValidator = runtimeAjv.compile(AGENTRC_SCHEMA);

/** Minimal document that satisfies the one required top-level block. */
const REQ = Object.freeze({
  project: {
    paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  },
});

const assertAgree = (value, label) => {
  const runtimeOk = runtimeValidator(value);
  const mirrorOk = mirrorValidator(value);
  assert.equal(
    mirrorOk,
    runtimeOk,
    `${label}: runtime AJV says ${runtimeOk}, generated 2020-12 mirror says ${mirrorOk}. ` +
      'The mirror is a serialization of the runtime schema, so a disagreement means the two ' +
      'dialects read the same keywords differently — not that the mirror is stale.',
  );
};

describe('generated config artifacts — freshness', () => {
  it('every artifact on disk matches what the generator emits', () => {
    const stale = buildArtifacts()
      .filter((a) => a.stale)
      .map((a) => a.name);
    assert.deepEqual(
      stale,
      [],
      'Generated config artifact(s) are stale. Run `npm run docs:gen`.',
    );
  });

  it('generation is deterministic — two runs emit identical bytes', () => {
    const first = buildArtifacts().map((a) => a.generated);
    const second = buildArtifacts().map((a) => a.generated);
    assert.deepEqual(second, first);
  });

  it('--check reports drift when the runtime schema gains a key', () => {
    // Reproduce the Epic #4131 failure class in reverse: a runtime key the
    // published mirror does not carry. The generator must call it stale
    // rather than reporting clean.
    const drifted = structuredClone(AGENTRC_SCHEMA);
    drifted.properties.delivery.properties.execution.properties.retryLimit = {
      type: 'integer',
    };
    const stale = buildArtifacts({ schema: drifted })
      .filter((a) => a.stale)
      .map((a) => a.name);
    assert.ok(
      stale.includes('mirror schema'),
      `expected the mirror to be reported stale, got ${JSON.stringify(stale)}`,
    );
    assert.ok(
      stale.includes('configuration.md key table'),
      `expected the key table to be reported stale, got ${JSON.stringify(stale)}`,
    );
  });

  it('--check reports drift when a default annotation moves', () => {
    const drifted = structuredClone(AGENTRC_SCHEMA);
    drifted.properties.delivery.properties.acceptanceEval.properties.maxRounds.default = 9;
    const stale = buildArtifacts({ schema: drifted })
      .filter((a) => a.stale)
      .map((a) => a.name);
    assert.ok(
      stale.includes('defaults inventory'),
      `expected the defaults inventory to be reported stale, got ${JSON.stringify(stale)}`,
    );
  });

  it('the on-disk mirror is byte-equal to the serialized runtime schema', () => {
    // Whitespace-insensitive, key-order-sensitive: the on-disk file is
    // Biome-formatted after the generator writes it.
    assert.equal(
      canonicalJson(JSON.parse(readFileSync(MIRROR_PATH, 'utf8'))),
      canonicalJson(buildMirrorSchema(AGENTRC_SCHEMA)),
    );
  });

  it('the mirror carries no $defs — it inlines the runtime schema', () => {
    assert.equal(mirror.$defs, undefined);
    assert.equal(
      mirror.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
    assert.match(mirror.description, /^GENERATED — do not edit/);
  });
});

describe('generated mirror — cross-dialect agreement with the runtime AJV schema', () => {
  it("accepts the shipped defaults inventory and this repo's own config", () => {
    const reference = JSON.parse(readFileSync(REFERENCE_PATH, 'utf8'));
    assertAgree(reference, 'agentrc-reference.json');
    const own = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', '.agentrc.json'), 'utf8'),
    );
    assertAgree(own, '.agentrc.json');
    assert.equal(runtimeValidator(own), true, 'this repo config must validate');
  });

  it('agrees on the minimal valid document and on a missing required block', () => {
    assertAgree(REQ, 'minimal valid');
    assertAgree({}, 'missing project');
    assertAgree({ project: {} }, 'project without paths');
  });

  it('agrees that unknown keys are rejected at every closed block', () => {
    assertAgree({ ...REQ, nope: 1 }, 'unknown root key');
    assertAgree(
      { project: { ...REQ.project, nope: 1 } },
      'unknown project key',
    );
    assertAgree({ ...REQ, delivery: { nope: 1 } }, 'unknown delivery key');
    assertAgree(
      { ...REQ, delivery: { quality: { gates: { nope: {} } } } },
      'unknown gate tier',
    );
  });

  it('agrees on the retired keys the v2 cutover rejects', () => {
    for (const doc of [
      { ...REQ, agentSettings: {} },
      { ...REQ, orchestration: {} },
      { ...REQ, planning: { context: { maxBytes: 1 } } },
      { ...REQ, planning: { maxSeedWords: 10 } },
      { ...REQ, planning: { codebaseSnapshot: {} } },
      { ...REQ, planning: { modelCapacity: {} } },
      { ...REQ, delivery: { lease: { ttlMs: 1 } } },
      { ...REQ, delivery: { epicAudit: {} } },
      { ...REQ, delivery: { ci: { earlyPr: true } } },
      { ...REQ, delivery: { ci: { requireChecks: true } } },
      { ...REQ, delivery: { deliverRunner: { clusterCeiling: 2 } } },
      { ...REQ, project: { ...REQ.project, commands: { lintBaseline: 'x' } } },
    ]) {
      assertAgree(doc, `retired key ${JSON.stringify(doc).slice(0, 80)}`);
      assert.equal(
        runtimeValidator(doc),
        false,
        `a retired key must fail closed: ${JSON.stringify(doc).slice(0, 80)}`,
      );
    }
  });

  it('accepts delivery.deliverRunner.footprintGuard on BOTH schemas (Story #5044, AC-5)', () => {
    // A knob that lands in only one of the two is dead on arrival: runtime-only
    // and every consumer's editor red-underlines a valid config; mirror-only
    // and DELIVERY_SCHEMA's `additionalProperties: false` rejects it at load.
    for (const mode of ['enforce', 'advisory']) {
      const doc = {
        ...REQ,
        delivery: { deliverRunner: { footprintGuard: mode } },
      };
      assertAgree(doc, `footprintGuard: ${mode}`);
      assert.equal(
        runtimeValidator(doc),
        true,
        `footprintGuard: '${mode}' must validate`,
      );
    }
    // The enum is closed — a typo must fail rather than silently disable the
    // guard, which is the failure mode a permissive string type would create.
    const bogus = {
      ...REQ,
      delivery: { deliverRunner: { footprintGuard: 'off' } },
    };
    assertAgree(bogus, 'footprintGuard: off');
    assert.equal(runtimeValidator(bogus), false);
  });

  it('agrees on the guards that are easy to get wrong across dialects', () => {
    // Shell-injection guard (`not: { pattern }`).
    assertAgree(
      {
        project: {
          paths: { ...REQ.project.paths, tempRoot: 'temp; rm -rf /' },
        },
      },
      'shell metacharacter in a safeString',
    );
    // Nullable-but-non-empty command.
    assertAgree(
      { ...REQ, project: { ...REQ.project, commands: { typecheck: null } } },
      'typecheck null',
    );
    assertAgree(
      { ...REQ, project: { ...REQ.project, commands: { typecheck: '' } } },
      'typecheck empty string',
    );
    // The list-or-extender union.
    assertAgree(
      { ...REQ, planning: { riskHeuristics: ['a'] } },
      'riskHeuristics array form',
    );
    assertAgree(
      { ...REQ, planning: { riskHeuristics: { append: ['a'] } } },
      'riskHeuristics extender form',
    );
    assertAgree(
      { ...REQ, planning: { riskHeuristics: { nope: ['a'] } } },
      'riskHeuristics bad extender',
    );
    // The conditional `root`-required-when-enabled rule (allOf/if/then).
    assertAgree(
      { ...REQ, delivery: { worktreeIsolation: { enabled: true } } },
      'worktreeIsolation enabled without root',
    );
    assertAgree(
      {
        ...REQ,
        delivery: { worktreeIsolation: { enabled: true, root: '.wt' } },
      },
      'worktreeIsolation enabled with root',
    );
    // uniqueItems + enum on the notification vocabularies.
    assertAgree(
      {
        ...REQ,
        github: {
          owner: 'o',
          repo: 'r',
          operatorHandle: '@me',
          notifications: { commentEvents: ['story-merged', 'story-merged'] },
        },
      },
      'duplicate commentEvents',
    );
    assertAgree(
      {
        ...REQ,
        github: {
          owner: 'o',
          repo: 'r',
          operatorHandle: '@me',
          notifications: { commentEvents: ['merge.unlanded'] },
        },
      },
      'webhook-only event on the comment channel',
    );
    // The qa map forms.
    assertAgree(
      { ...REQ, qa: { personas: ['admin'] } },
      'qa personas array form',
    );
    assertAgree(
      { ...REQ, qa: { personas: { admin: { credentialRef: 'X' } } } },
      'qa personas map form',
    );
    assertAgree(
      { ...REQ, qa: { personas: { admin: { nope: 'X' } } } },
      'qa personas bad map entry',
    );
    assertAgree({ ...REQ, qa: { environments: {} } }, 'qa empty environments');
  });
});

// ---------------------------------------------------------------------------
// Baseline schema registry drift test (Story #1888).
//
// The shared registry in config-schema-shared.js lists every baseline schema
// that AJV consumers should be able to compile. The on-disk directory under
// .agents/schemas/baselines/ is the second source of truth. Whenever a new
// per-kind schema lands on disk without an entry in BASELINE_KIND_SCHEMA_FILES,
// the registry stops covering it — these tests catch that drift loudly.
// ---------------------------------------------------------------------------

describe('baseline schema registry — drift vs .agents/schemas/baselines/', () => {
  it('every registered schema id loads through buildBaselineSchemaAjv without throwing', () => {
    const ajv = buildBaselineSchemaAjv();
    for (const filename of BASELINE_SCHEMA_FILES) {
      const schemaObj = ajv.getSchema(filename);
      assert.ok(
        schemaObj,
        `${filename} is not reachable from the shared AJV registry`,
      );
    }
  });

  it('registry list matches the on-disk *.schema.json contents', () => {
    const onDisk = readdirSync(BASELINE_SCHEMAS_DIR)
      .filter((name) => name.endsWith('.schema.json'))
      .sort();
    const registered = [...BASELINE_SCHEMA_FILES].sort();
    assert.deepEqual(
      onDisk,
      registered,
      'Baseline schema directory drifted from BASELINE_SCHEMA_FILES. ' +
        'When a new schema lands under .agents/schemas/baselines/, add it ' +
        'to BASELINE_KIND_SCHEMA_FILES in config-schema-shared.js.',
    );
  });
});
