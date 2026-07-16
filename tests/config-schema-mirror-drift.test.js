import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  BASELINE_SCHEMA_FILES,
  BASELINE_SCHEMAS_DIR,
  buildBaselineSchemaAjv,
} from '../.agents/scripts/lib/config-schema-shared.js';
import { AGENTRC_SCHEMA } from '../.agents/scripts/lib/config-settings-schema.js';

// ---------------------------------------------------------------------------
// Behavioural drift test — directionality contract.
//
// Authoritative direction: AJV → mirror. The runtime AJV schema in
// config-settings-schema.js is the SOURCE OF TRUTH; the static
// .agents/schemas/agentrc.schema.json file is an ADVISORY human-readable
// mirror. When the two diverge, the AJV side wins and the mirror MUST be
// updated to match — never the other way around.
//
// Post-reshape (Epic #1720 Story #1739) the doc-level schema validates
// the four top-level blocks {project, github, planning, delivery}.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIRROR_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'schemas',
  'agentrc.schema.json',
);

const mirror = JSON.parse(readFileSync(MIRROR_PATH, 'utf8'));

const ajv2020 = new Ajv2020({ allErrors: true });
addFormats(ajv2020);
const mirrorValidator = ajv2020.compile(mirror);

const runtimeAjv = new Ajv({ allErrors: true });
addFormats(runtimeAjv);
const runtimeValidator = runtimeAjv.compile(AGENTRC_SCHEMA);

const REQ = Object.freeze({
  project: Object.freeze({
    paths: Object.freeze({
      agentRoot: '.agents',
      docsRoot: 'docs',
      tempRoot: 'temp',
    }),
  }),
});

const assertAgree = (value, label) => {
  const runtimeOk = runtimeValidator(value);
  const mirrorOk = mirrorValidator(value);
  let directionalHint = '';
  if (runtimeOk && !mirrorOk) {
    directionalHint =
      ' Static JSON Schema mirror rejects an input the runtime AJV schema accepts.' +
      ' The AJV schema is authoritative; update .agents/schemas/agentrc.schema.json to match.';
  } else if (!runtimeOk && mirrorOk) {
    directionalHint =
      ' Static JSON Schema mirror accepts an input the runtime AJV schema rejects.' +
      ' The AJV schema is authoritative; tighten .agents/schemas/agentrc.schema.json to match.';
  }
  assert.equal(
    mirrorOk,
    runtimeOk,
    `${label}: runtime=${runtimeOk} mirror=${mirrorOk}.${directionalHint}`,
  );
};

describe('agentrc.schema.json mirror — drift vs runtime AJV schema', () => {
  it('mirror exposes the four top-level blocks under $defs', () => {
    for (const def of ['project', 'github', 'planning', 'delivery']) {
      assert.ok(mirror.$defs[def], `mirror is missing $defs.${def}`);
    }
  });

  it('mirror references a draft 2020-12 $schema', () => {
    assert.equal(
      mirror.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  it('accepts a minimal valid doc on both sides', () => {
    assertAgree({ ...REQ }, 'minimal valid doc');
  });

  it('accepts a populated doc on both sides', () => {
    assertAgree(
      {
        project: {
          baseBranch: 'main',
          paths: REQ.project.paths,
          docsContextFiles: ['architecture.md'],
          commands: {
            test: 'npm test',
            typecheck: null,
            lintBaseline: 'npm run lint',
            formatCheck: 'npx biome format .',
            formatWrite: 'npx biome format --write .',
          },
        },
        github: {
          owner: 'dsj1984',
          repo: 'mandrel',
          operatorHandle: '@dsj1984',
          branchProtection: {
            enforce: true,
            requiredChecks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
          },
          mergeMethods: { allow_squash_merge: true },
          notifications: {
            mentionOperator: false,
            commentEvents: ['state-transition'],
            webhookEvents: ['epic-started'],
          },
        },
        planning: {
          riskHeuristics: ['no destructive ops'],
          context: { maxBytes: 50000, summaryMode: 'auto' },
        },
        delivery: {
          execution: { timeoutMs: 600000 },
          docsFreshness: { paths: ['README.md'] },
          deliverRunner: { concurrencyCap: 3 },
          worktreeIsolation: {
            enabled: true,
            root: '.worktrees',
            nodeModulesStrategy: 'per-worktree',
          },
          signals: {
            rework: { editsPerFile: 5 },
            retry: { repeatCount: 3 },
          },
          quality: {
            gateScoping: { scope: 'diff', diffRef: 'main' },
            gates: {
              coverage: {
                enabled: true,
                baselinePath: 'baselines/coverage.json',
                tolerance: { kind: 'absolute', value: 0 },
                floors: { '*': { lines: 90, branches: 85, functions: 90 } },
                coveragePath: 'coverage/coverage-final.json',
              },
              crap: {
                enabled: true,
                baselinePath: 'baselines/crap.json',
                tolerance: { kind: 'absolute', value: 0.05 },
                floors: { '*': { max: 30, p95: 20, methodsAbove20: 50 } },
                targetDirs: ['src'],
                newMethodCeiling: 30,
                requireCoverage: true,
              },
              maintainability: {
                enabled: true,
                baselinePath: 'baselines/maintainability.json',
                tolerance: { kind: 'absolute', value: 0.5 },
                floors: { '*': { maintainability: 70 } },
                targetDirs: ['src'],
              },
            },
            codingGuardrails: {
              cyclomaticFlag: 8,
              cyclomaticMustFix: 12,
              requireSiblingTest: false,
            },
          },
        },
      },
      'fully populated doc',
    );
  });

  it('rejects the retired miDropMustRefactor / miDropCap keys on both sides (Story #4531)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: { codingGuardrails: { miDropMustRefactor: 1.5 } },
        },
      },
      'retired codingGuardrails.miDropMustRefactor',
    );
    assertAgree(
      {
        ...REQ,
        delivery: { quality: { autoRefresh: { miDropCap: 1.5 } } },
      },
      'retired autoRefresh.miDropCap',
    );
  });

  it('rejects the removed planning.maxTickets knob on both sides (Story #4163)', () => {
    // `maxTickets` collapsed to a framework constant; both the runtime AJV
    // schema and the static mirror dropped it, so `additionalProperties:
    // false` on the planning block rejects it identically on both sides.
    assertAgree(
      { ...REQ, planning: { maxTickets: 60 } },
      'removed planning.maxTickets knob',
    );
  });

  it('accepts per-component globs under gates.<kind>.components (Story #1892)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              coverage: {
                baselinePath: 'baselines/coverage.json',
                floors: { '*': { lines: 80 } },
                components: {
                  app: ['src/app/**'],
                  worker: ['src/worker/**'],
                },
              },
            },
          },
        },
      },
      'per-component globs',
    );
  });

  it('accepts new rollup-keyed floors (Story #1892)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: {
              crap: {
                baselinePath: 'baselines/crap.json',
                floors: { '*': { p95: 5, perMethod: 30 } },
              },
              maintainability: {
                baselinePath: 'baselines/maintainability.json',
                floors: { '*': { min: 50, p50: 80 } },
              },
              mutation: {
                baselinePath: 'baselines/mutation.json',
                floors: { '*': { score: 70 } },
              },
              lint: {
                baselinePath: 'baselines/lint.json',
                floors: { '*': { errorCount: 0, warningCount: 0 } },
              },
            },
          },
        },
      },
      'rollup-keyed floors',
    );
  });

  it('accepts delivery.acceptanceEval.maxRounds on both sides (Story #3819)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { acceptanceEval: { maxRounds: 3 } },
      },
      'acceptanceEval.maxRounds',
    );
  });

  it('rejects delivery.acceptanceEval.maxRounds below 1 on both sides (Story #3819)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { acceptanceEval: { maxRounds: 0 } },
      },
      'acceptanceEval.maxRounds minimum 1',
    );
  });

  it('rejects an unknown key under delivery.acceptanceEval on both sides (Story #3819)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { acceptanceEval: { enabled: true } },
      },
      'acceptanceEval has no enabled flag (always-on hard cutover)',
    );
  });

  it('accepts delivery.codeReview.autoFixSeverity on both sides (Story #4399)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          codeReview: { autoFixSeverity: 'medium' },
        },
      },
      'autoFixSeverity high|medium',
    );
  });

  it('rejects delivery.epicAudit on both sides (removed on v2)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          epicAudit: { autoFixSeverity: 'high' },
        },
      },
      'removed delivery.epicAudit block',
    );
  });

  it('rejects an unknown autoFixSeverity value on both sides (Story #4399)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { codeReview: { autoFixSeverity: 'low' } },
      },
      'autoFixSeverity enum high|medium only',
    );
  });

  it('rejects delivery.maxTokenBudget on both sides (framework constant)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { maxTokenBudget: 200000 },
      },
      'removed delivery.maxTokenBudget knob',
    );
  });

  it('rejects delivery.preflight on both sides (module removed)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { preflight: { maxStories: 100 } },
      },
      'removed delivery.preflight block',
    );
  });

  it('rejects delivery.ci.earlyPr on both sides (Story #4356)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { ci: { earlyPr: false } },
      },
      'removed delivery.ci.earlyPr knob',
    );
  });

  it('rejects delivery.ci.requireChecks on both sides (Story #4356)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { ci: { requireChecks: true } },
      },
      'removed delivery.ci.requireChecks knob',
    );
  });

  it('rejects legacy agentSettings on both sides', () => {
    assertAgree(
      { agentSettings: { paths: REQ.project.paths } },
      'legacy agentSettings',
    );
  });

  it('rejects legacy orchestration on both sides', () => {
    assertAgree(
      { ...REQ, orchestration: { provider: 'github' } },
      'legacy orchestration',
    );
  });

  it('rejects unknown top-level keys on both sides', () => {
    assertAgree({ ...REQ, mystery: true }, 'unknown top-level key');
  });

  it('rejects shell-injection in project.baseBranch on both sides', () => {
    assertAgree(
      { project: { ...REQ.project, baseBranch: 'main; rm -rf /' } },
      'shell injection in baseBranch',
    );
  });

  it('rejects unknown property under project.commands on both sides', () => {
    assertAgree(
      {
        project: { ...REQ.project, commands: { build: 'npm run build' } },
      },
      'commands typo (build dropped)',
    );
  });

  it('rejects renamed-away miDropRefactor on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: { codingGuardrails: { miDropRefactor: 1.5 } },
        },
      },
      'renamed codingGuardrails field',
    );
  });

  it('rejects dropped halsteadTolerance on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: { gates: { maintainability: { halsteadTolerance: 0.1 } } },
        },
      },
      'dropped halsteadTolerance',
    );
  });

  it('rejects scalar tolerance on both sides (object shape only)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { quality: { gates: { crap: { tolerance: 0.05 } } } },
      },
      'scalar tolerance migrated to { kind, value }',
    );
  });

  it('rejects floors without the catch-all key on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: { coverage: { floors: { 'packages/web': { lines: 90 } } } },
          },
        },
      },
      "floors require '*' catch-all",
    );
  });

  it('rejects coveragePath on the CRAP gate (moved to coverage)', () => {
    assertAgree(
      {
        ...REQ,
        delivery: {
          quality: {
            gates: { crap: { coveragePath: 'coverage/coverage-final.json' } },
          },
        },
      },
      'coveragePath ownership moved to coverage gate',
    );
  });

  it('rejects dropped signals.hotspot on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { signals: { hotspot: { p95Multiplier: 1.25 } } },
      },
      'dropped signals.hotspot',
    );
  });

  it('rejects dropped signals.churn on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { signals: { churn: { repeatCount: 4 } } },
      },
      'dropped signals.churn',
    );
  });

  it('rejects legacy deliverRunner.enabled on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { deliverRunner: { enabled: true } },
      },
      'dropped deliverRunner.enabled',
    );
  });

  it('rejects planning.modelCapacity on both sides (framework constant)', () => {
    assertAgree(
      {
        ...REQ,
        planning: {
          modelCapacity: {
            softSessionTokens: 20000,
            hardSessionTokens: 60000,
          },
        },
      },
      'collapsed planning.modelCapacity key',
    );
  });

  it('rejects the retired planning.taskSizing key on both sides (v2 Stage 2)', () => {
    assertAgree(
      {
        ...REQ,
        planning: {
          taskSizing: {
            softFiles: 15,
            hardFiles: 30,
          },
        },
      },
      'retired planning.taskSizing key',
    );
  });

  it('rejects worktreeIsolation without root when enabled is true on both sides', () => {
    assertAgree(
      {
        ...REQ,
        delivery: { worktreeIsolation: { enabled: true } },
      },
      'conditional root required when enabled=true',
    );
  });

  // -------------------------------------------------------------------------
  // qa block — agent-driven QA harness contract (Epic #3214, Story #3293).
  // -------------------------------------------------------------------------

  it('accepts a well-formed qa block with url-template signInSeam on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: {
          featureRoot: 'tests/features',
          fixturesManifest: 'tests/fixtures/manifest.json',
          signInSeam: { urlTemplate: 'https://app.test/login?as=admin' },
          personas: {
            admin: { credentialRef: 'env:ADMIN_CREDS' },
            member: { signInSkill: 'stack/qa/sign-in' },
          },
          consoleAllowlist: ['ResizeObserver loop limit exceeded'],
          designTokens: 'design/tokens.json',
        },
      },
      'qa block with url-template signInSeam',
    );
  });

  it('accepts a qa block with skill signInSeam on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: {
          featureRoot: 'tests/features',
          signInSeam: { skill: 'stack/qa/sign-in' },
        },
      },
      'qa block with skill signInSeam',
    );
  });

  it('rejects a qa signInSeam that is neither url-template nor skill on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { signInSeam: { token: 'inline-secret' } },
      },
      'qa signInSeam neither variant',
    );
  });

  it('rejects a qa signInSeam that satisfies both variants on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: {
          signInSeam: {
            urlTemplate: 'https://app.test/login',
            skill: 'stack/qa/sign-in',
          },
        },
      },
      'qa signInSeam both variants (oneOf rejects)',
    );
  });

  it('rejects shell-injection in qa.featureRoot on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { featureRoot: 'tests/features; rm -rf /' },
      },
      'shell injection in qa.featureRoot',
    );
  });

  it('rejects shell-injection in qa.fixturesManifest on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { fixturesManifest: 'fixtures/$(whoami).json' },
      },
      'shell injection in qa.fixturesManifest',
    );
  });

  it('rejects shell-injection in qa.designTokens on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { designTokens: 'tokens.json && cat /etc/passwd' },
      },
      'shell injection in qa.designTokens',
    );
  });

  it('rejects an unknown key inside the qa block on both sides (Story #3293)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { mystery: true },
      },
      'unknown key in qa block',
    );
  });

  it('accepts a name-only personas array on both sides (Story #3306)', () => {
    assertAgree(
      {
        ...REQ,
        qa: {
          featureRoot: 'tests/features',
          fixturesManifest: 'tests/fixtures/manifest.json',
          signInSeam: { urlTemplate: '/dev/sign-in-as/{persona}' },
          personas: ['athlete', 'coach', 'org-admin'],
        },
      },
      'qa block with name-only personas array',
    );
  });

  it('accepts the object-map personas form on both sides (Story #3306)', () => {
    assertAgree(
      {
        ...REQ,
        qa: {
          signInSeam: { skill: 'stack/qa/sign-in' },
          personas: {
            admin: { credentialRef: 'env:ADMIN_CREDS' },
            member: { signInSkill: 'stack/qa/sign-in-member' },
          },
        },
      },
      'qa block with object-map personas',
    );
  });

  it('rejects an empty personas array on both sides (Story #3306)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { personas: [] },
      },
      'empty personas array (minItems)',
    );
  });

  it('rejects an empty personas object-map on both sides (Story #3306)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { personas: { admin: {} } },
      },
      'object-map persona without auth material',
    );
  });

  it('rejects a blank persona name in the array on both sides (Story #3306)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { personas: [''] },
      },
      'blank persona name (minLength)',
    );
  });

  it('rejects shell-injection in a name-only persona on both sides (Story #3306)', () => {
    assertAgree(
      {
        ...REQ,
        qa: { personas: ['admin; rm -rf /'] },
      },
      'shell injection in name-only persona',
    );
  });
});

// ---------------------------------------------------------------------------
// Structural property-coverage parity test (Story #4146).
//
// The `assertAgree` cases above only catch drift on the *specific* inputs they
// happen to feed both validators. They are blind to the failure shape that
// matters most: a property documented in the published mirror
// (`agentrc.schema.json`) that the runtime AJV validator rejects on load —
// the Epic #4131 bug, where `planning.navigation` / `delivery.quality
// .navigability` shipped into the mirror + docs but not the runtime schema, so
// a consumer who set the documented key had their entire `.agentrc.json`
// rejected (dead-on-arrival; fixed in PR #4142). No `assertAgree` case
// exercised those keys, so the guard never tripped.
//
// This block closes that gap structurally. It walks BOTH schemas, deref'ing
// local `$ref` pointers, and collects — for every `additionalProperties:false`
// object block — the set of declared property keys, keyed by a structural path
// that is identical across the inline (runtime) and `$ref` (mirror)
// representations. It then asserts BIDIRECTIONAL parity: every closed block one
// schema declares, the other must declare with the SAME key set. A property
// present in the mirror but absent from the runtime validator (the #4131 shape)
// — or the reverse — fails loudly here, independent of any sampled input.
//
// The two reproduce-the-bug cases mutate a deep copy of each real schema and
// assert the comparator catches the injected divergence in each direction, so
// the guard is proven load-bearing, not merely green on consistent input.
// ---------------------------------------------------------------------------

/**
 * Resolve a local (`#/...`) `$ref` against the document root, following chained
 * refs and guarding against cycles. Non-local refs and non-ref nodes pass
 * through unchanged. Pure: returns a node from `root`, never mutates.
 */
function derefLocal(node, root, seenRefs) {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith('#/')) return node;
    if (seenRefs.has(ref)) return node;
    const segments = ref.slice(2).split('/');
    let target = root;
    for (const seg of segments) {
      const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
      target = target?.[key];
    }
    if (!target) return node;
    return derefLocal(target, root, new Set([...seenRefs, ref]));
  }
  return node;
}

/**
 * Walk a JSON-Schema document and return a `Map<structuralPath, string[]>`
 * holding the sorted property-key set of every `additionalProperties:false`
 * object subschema. The path keys are built from `properties` names and
 * positional combinator/`items`/`additionalProperties` suffixes, so the inline
 * runtime schema and the `$ref`-based mirror produce identical keys for the
 * same logical block.
 */
function collectClosedBlocks(schema, root) {
  const out = new Map();
  const visit = (rawNode, pathKey, seenRefs) => {
    const node = derefLocal(rawNode, root, seenRefs);
    if (!node || typeof node !== 'object') return;
    const isObjectSchema =
      node.type === 'object' ||
      (node.properties && typeof node.properties === 'object');
    if (isObjectSchema && node.additionalProperties === false) {
      out.set(
        pathKey,
        node.properties ? Object.keys(node.properties).sort() : [],
      );
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, sub] of Object.entries(node.properties)) {
        visit(sub, `${pathKey}.${key}`, seenRefs);
      }
    }
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === 'object'
    ) {
      visit(
        node.additionalProperties,
        `${pathKey}.<additionalProperties>`,
        seenRefs,
      );
    }
    if (node.items && typeof node.items === 'object') {
      visit(node.items, `${pathKey}[items]`, seenRefs);
    }
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(node[combinator])) {
        node[combinator].forEach((sub, i) => {
          visit(sub, `${pathKey}.${combinator}[${i}]`, seenRefs);
        });
      }
    }
    if (node.not && typeof node.not === 'object') {
      visit(node.not, `${pathKey}.not`, seenRefs);
    }
  };
  visit(schema, '$', new Set());
  return out;
}

/**
 * Diff two closed-block maps and return the structural divergences as three
 * flat string arrays. An empty result on every axis means the two schemas
 * agree on every property path. The runtime schema is the authoritative
 * SOURCE (see the directionality note at the top of this file); the mirror
 * must match it.
 */
function diffClosedBlocks(runtimeBlocks, mirrorBlocks) {
  const runtimeKeys = new Set(runtimeBlocks.keys());
  const mirrorKeys = new Set(mirrorBlocks.keys());
  const onlyRuntime = [...runtimeKeys].filter((k) => !mirrorKeys.has(k)).sort();
  const onlyMirror = [...mirrorKeys].filter((k) => !runtimeKeys.has(k)).sort();
  const propMismatches = [];
  for (const key of [...runtimeKeys].filter((k) => mirrorKeys.has(k)).sort()) {
    const runtimeProps = runtimeBlocks.get(key).join(', ');
    const mirrorProps = mirrorBlocks.get(key).join(', ');
    if (runtimeProps !== mirrorProps) {
      propMismatches.push(
        `${key}: runtime={${runtimeProps}} mirror={${mirrorProps}}`,
      );
    }
  }
  return { onlyRuntime, onlyMirror, propMismatches };
}

describe('agentrc.schema.json mirror — structural property-coverage parity (Story #4146)', () => {
  const runtimeBlocks = collectClosedBlocks(AGENTRC_SCHEMA, AGENTRC_SCHEMA);
  const mirrorBlocks = collectClosedBlocks(mirror, mirror);

  it('the walker discovers a non-trivial set of closed blocks on both sides', () => {
    // Guards against a silently-empty walk (e.g. a deref regression) making
    // every parity assertion below vacuously pass.
    assert.ok(
      runtimeBlocks.size >= 50,
      `expected the runtime schema to expose many additionalProperties:false blocks, got ${runtimeBlocks.size}`,
    );
    assert.ok(
      mirrorBlocks.size >= 50,
      `expected the mirror to expose many additionalProperties:false blocks, got ${mirrorBlocks.size}`,
    );
  });

  it('no property path is accepted by the mirror but rejected by the runtime AJV schema (the Epic #4131 shape)', () => {
    const { onlyMirror } = diffClosedBlocks(runtimeBlocks, mirrorBlocks);
    assert.deepEqual(
      onlyMirror,
      [],
      'Static JSON Schema mirror declares closed blocks the runtime AJV schema does not — ' +
        'a consumer who sets these documented keys would have their .agentrc.json rejected on load ' +
        '(Epic #4131 dead-on-arrival shape). Add the missing properties to the runtime schema in ' +
        'config-settings-schema*.js. Divergent paths:\n  ' +
        onlyMirror.join('\n  '),
    );
  });

  it('no property path is accepted by the runtime AJV schema but omitted from the mirror', () => {
    const { onlyRuntime } = diffClosedBlocks(runtimeBlocks, mirrorBlocks);
    assert.deepEqual(
      onlyRuntime,
      [],
      'Runtime AJV schema declares closed blocks the static mirror omits — the published ' +
        'agentrc.schema.json no longer documents a key the runtime accepts. Add the missing ' +
        'properties to .agents/schemas/agentrc.schema.json. Divergent paths:\n  ' +
        onlyRuntime.join('\n  '),
    );
  });

  it('every shared closed block enumerates the same property keys on both sides', () => {
    const { propMismatches } = diffClosedBlocks(runtimeBlocks, mirrorBlocks);
    assert.deepEqual(
      propMismatches,
      [],
      'A closed object block declares a different property-key set in the runtime schema vs the ' +
        'mirror. Reconcile the two so they enumerate identical keys. Mismatches:\n  ' +
        propMismatches.join('\n  '),
    );
  });

  // -------------------------------------------------------------------------
  // Reproduce-the-bug fixtures (Story #4146 acceptance criteria 1 & 2).
  //
  // The current schemas agree, so the parity assertions above pass. These two
  // cases prove the comparator actually FAILS on injected divergence — without
  // them, the guard could pass purely because the schemas happen to be aligned
  // today, never because it can detect drift. We deep-clone the real schemas,
  // inject one divergence in each direction, and assert the diff reports it.
  // -------------------------------------------------------------------------

  const clone = (value) => JSON.parse(JSON.stringify(value));

  it('FAILS when a property is present in the mirror but absent from the runtime (Epic #4131 reproduction)', () => {
    // Arrange: a mirror that documents planning.navigation.depthLimit, a key
    // the runtime validator does not accept (the #4131 dead-on-arrival shape).
    const driftedMirror = clone(mirror);
    driftedMirror.$defs.planning.properties.navigation.properties.depthLimit = {
      type: 'integer',
    };

    // Act
    const driftedMirrorBlocks = collectClosedBlocks(
      driftedMirror,
      driftedMirror,
    );
    const { onlyMirror, propMismatches } = diffClosedBlocks(
      runtimeBlocks,
      driftedMirrorBlocks,
    );

    // Assert: the comparator surfaces the planning.navigation block as a
    // property-key mismatch (mirror has depthLimit, runtime does not).
    assert.ok(
      propMismatches.some((m) => m.includes('navigation')) ||
        onlyMirror.length > 0,
      `expected the comparator to flag the injected mirror-only key, but it reported clean. ` +
        `onlyMirror=${JSON.stringify(onlyMirror)} propMismatches=${JSON.stringify(propMismatches)}`,
    );
  });

  it('FAILS for the reverse divergence — the runtime accepts a key the mirror omits', () => {
    // Arrange: a runtime schema that accepts delivery.execution.retryLimit, a
    // key the published mirror does not document.
    const driftedRuntime = clone(AGENTRC_SCHEMA);
    driftedRuntime.properties.delivery.properties.execution.properties.retryLimit =
      { type: 'integer' };

    // Act
    const driftedRuntimeBlocks = collectClosedBlocks(
      driftedRuntime,
      driftedRuntime,
    );
    const { onlyRuntime, propMismatches } = diffClosedBlocks(
      driftedRuntimeBlocks,
      mirrorBlocks,
    );

    // Assert: the comparator surfaces the delivery.execution block as a
    // property-key mismatch (runtime has retryLimit, mirror does not).
    assert.ok(
      propMismatches.some((m) => m.includes('execution')) ||
        onlyRuntime.length > 0,
      `expected the comparator to flag the injected runtime-only key, but it reported clean. ` +
        `onlyRuntime=${JSON.stringify(onlyRuntime)} propMismatches=${JSON.stringify(propMismatches)}`,
    );
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
