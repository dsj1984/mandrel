// tests/baselines/scope.test.js
//
// Story #1962 / Task #1970 — Lock the precedence ladder for the unified
// `resolveScope({kind, configScope, configRef, cliFlags})` helper. Every
// future per-kind regression CLI in Epic #1943 calls this exactly once
// per run; the wrong precedence here would silently desync the
// dispatcher's read scope from the writer's write scope.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveScope } from '../../.agents/scripts/lib/baselines/scope.js';

describe('resolveScope — full mode (acceptance)', () => {
  it("returns mode='full', files=Set(), ref=null when configScope='full'", () => {
    const r = resolveScope({ kind: 'lint', configScope: 'full' });
    assert.equal(r.kind, 'lint');
    assert.equal(r.mode, 'full');
    assert.equal(r.ref, null);
    assert.ok(r.files instanceof Set);
    assert.equal(r.files.size, 0);
    assert.equal(r.source, 'config:gateScoping.scope=full');
  });

  it("CLI --full-scope flag forces mode='full' even when config says diff", () => {
    const r = resolveScope({
      kind: 'crap',
      configScope: 'diff',
      configRef: 'main',
      cliFlags: { fullScope: true },
    });
    assert.equal(r.mode, 'full');
    assert.equal(r.ref, null);
    assert.equal(r.files.size, 0);
    assert.equal(r.source, 'cli:--full-scope');
  });

  it("env BASELINE_SCOPE='full' forces mode='full' over config diff", () => {
    const r = resolveScope({
      kind: 'coverage',
      configScope: 'diff',
      configRef: 'epic/1943',
      cliFlags: { envScope: 'full' },
    });
    assert.equal(r.mode, 'full');
    assert.equal(r.ref, null);
    assert.equal(r.source, 'env:BASELINE_SCOPE=full');
  });

  it('returns a frozen result so callers cannot mutate the resolution', () => {
    const r = resolveScope({ kind: 'lint', configScope: 'full' });
    assert.ok(Object.isFrozen(r));
  });
});

describe('resolveScope — precedence layers', () => {
  it('CLI --changed-since beats env, config, and default', () => {
    const r = resolveScope({
      kind: 'mutation',
      configScope: 'diff',
      configRef: 'main',
      cliFlags: {
        changedSinceRef: 'epic/1943',
        envRef: 'origin/main',
        envScope: 'diff',
      },
    });
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'epic/1943');
    assert.equal(r.source, 'cli:--changed-since');
  });

  it('env BASELINE_REF beats config when no CLI flag is set', () => {
    const r = resolveScope({
      kind: 'lighthouse',
      configScope: 'diff',
      configRef: 'main',
      cliFlags: { envRef: 'origin/main' },
    });
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'origin/main');
    assert.equal(r.source, 'env:BASELINE_REF');
  });

  it('config gateScoping.diffRef beats default', () => {
    const r = resolveScope({
      kind: 'maintainability',
      configScope: 'diff',
      configRef: 'epic/1943',
    });
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'epic/1943');
    assert.equal(r.source, 'config:gateScoping.diffRef');
  });

  it('falls back to diff against main when nothing is configured', () => {
    const r = resolveScope({ kind: 'crap' });
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'main');
    assert.equal(r.source, 'default');
  });
});

describe('resolveScope — missing-ref fallback', () => {
  it('config scope=diff with no diffRef falls back to ref=main', () => {
    const r = resolveScope({ kind: 'lint', configScope: 'diff' });
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'main');
    assert.equal(r.source, 'config:gateScoping.scope=diff');
  });

  it("env scope='diff' with no envRef falls back to ref=main", () => {
    const r = resolveScope({
      kind: 'coverage',
      cliFlags: { envScope: 'diff' },
    });
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'main');
    assert.equal(r.source, 'env:BASELINE_SCOPE=diff');
  });

  it('treats empty-string ref as missing (not a valid override)', () => {
    const r = resolveScope({
      kind: 'lint',
      configScope: 'diff',
      configRef: '',
      cliFlags: { changedSinceRef: '', envRef: '' },
    });
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'main');
    assert.equal(r.source, 'config:gateScoping.scope=diff');
  });
});

describe('resolveScope — diff-vs-full inputs', () => {
  it('forwards changedFiles into files Set in diff mode', () => {
    const r = resolveScope({
      kind: 'lint',
      configScope: 'diff',
      configRef: 'main',
      cliFlags: {
        changedFiles: ['src/a.ts', 'src/b.ts', 'src/a.ts'],
      },
    });
    assert.equal(r.mode, 'diff');
    assert.deepEqual([...r.files].sort(), ['src/a.ts', 'src/b.ts']);
  });

  it('drops non-string entries from changedFiles defensively', () => {
    const r = resolveScope({
      kind: 'crap',
      configScope: 'diff',
      configRef: 'main',
      cliFlags: { changedFiles: ['ok.ts', 42, null, '', 'also-ok.ts'] },
    });
    assert.deepEqual([...r.files].sort(), ['also-ok.ts', 'ok.ts']);
  });

  it('ignores changedFiles in full mode (files is always empty)', () => {
    const r = resolveScope({
      kind: 'lint',
      configScope: 'full',
      cliFlags: { changedFiles: ['ignored.ts'] },
    });
    assert.equal(r.mode, 'full');
    assert.equal(r.files.size, 0);
  });
});

describe('resolveScope — input hardening', () => {
  it('coerces missing/blank kind to "unknown"', () => {
    const r = resolveScope({});
    assert.equal(r.kind, 'unknown');
  });

  it('ignores unknown configScope values (treated as "not specified")', () => {
    const r = resolveScope({
      kind: 'lint',
      configScope: 'sometimes',
      configRef: 'main',
    });
    // Scope mode unspecified but configRef present → diff against configRef.
    assert.equal(r.mode, 'diff');
    assert.equal(r.ref, 'main');
    assert.equal(r.source, 'config:gateScoping.diffRef');
  });

  it('accepts a Set as changedFiles input', () => {
    const r = resolveScope({
      kind: 'lint',
      configScope: 'diff',
      configRef: 'main',
      cliFlags: { changedFiles: new Set(['x.ts']) },
    });
    assert.deepEqual([...r.files], ['x.ts']);
  });
});
