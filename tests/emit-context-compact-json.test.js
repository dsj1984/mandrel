import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const heuristics = [
  'Destructive or irreversible data mutations.',
  'Modifications to shared security or auth infrastructure.',
  'Changes to CI/CD or release gating.',
  'Monorepo-wide AST or text replacements.',
  'Schema migrations without backfill or rollback plan.',
  'Concurrency or locking primitives in shared paths.',
  'Public API surface or wire-format changes.',
  'Removal of feature flags backing live experiments.',
];

const docsFiles = [
  'docs/architecture.md',
  'docs/decisions.md',
  'docs/operating-procedures/release.md',
  'docs/operating-procedures/incident.md',
  'docs/operating-procedures/rollback.md',
  'docs/glossary.md',
  'docs/onboarding.md',
  'docs/playbooks/sev1.md',
  'docs/playbooks/sev2.md',
  'README.md',
].map((p, i) => ({
  path: p,
  sha: `sha${i.toString().padStart(7, '0')}`,
  size: 1000 + i * 137,
  kind: 'md',
}));

const fixture = {
  epic: {
    id: 817,
    title: 'Reduce token spend in planning prompts',
    body: 'Trim emit-context payloads.',
    linkedIssues: { prd: 818, techSpec: 819 },
  },
  prd: {
    id: 818,
    body: 'Goals: lower per-Epic prompt cost; preserve roundtrip parity.',
  },
  techSpec: {
    id: 819,
    body: 'All four planner scripts share an identical emit-context branch.',
  },
  heuristics,
  systemPrompt: 'Author backlog tickets matching the schema.',
  maxTickets: 25,
  docsContext: { files: docsFiles },
};

function emit(ctx, { pretty }) {
  return pretty ? JSON.stringify(ctx, null, 2) : JSON.stringify(ctx);
}

describe('emit-context compact JSON output', () => {
  it('default (compact) and --pretty round-trip to deep-equal objects', () => {
    const compact = emit(fixture, { pretty: false });
    const pretty = emit(fixture, { pretty: true });
    assert.deepStrictEqual(JSON.parse(compact), JSON.parse(pretty));
    assert.deepStrictEqual(JSON.parse(compact), fixture);
  });

  it('compact output contains no formatting whitespace between tokens', () => {
    const compact = emit(fixture, { pretty: false });
    assert.ok(
      !compact.includes('\n'),
      'compact output must not contain newlines',
    );
    assert.ok(
      !/:\s\s/.test(compact),
      'compact output must not contain indentation runs',
    );
  });
});
