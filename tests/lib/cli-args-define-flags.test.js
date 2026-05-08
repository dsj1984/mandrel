import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineFlags } from '../../.agents/scripts/lib/cli-args.js';

describe('defineFlags — type coercion', () => {
  it('boolean: true when present, false when absent', () => {
    const spec = { 'dry-run': { type: 'boolean' } };
    assert.equal(defineFlags(spec, []).values.dryRun, false);
    assert.equal(defineFlags(spec, ['--dry-run']).values.dryRun, true);
  });

  it('ticket: returns positive integer or null, strips leading #', () => {
    const spec = { story: { type: 'ticket', alias: 'storyId' } };
    assert.equal(defineFlags(spec, []).values.storyId, null);
    assert.equal(defineFlags(spec, ['--story', '42']).values.storyId, 42);
    assert.equal(defineFlags(spec, ['--story', '#42']).values.storyId, 42);
    assert.equal(defineFlags(spec, ['--story', 'abc']).values.storyId, null);
    assert.equal(defineFlags(spec, ['--story', '0']).values.storyId, null);
    assert.equal(defineFlags(spec, ['--story', '-3']).values.storyId, null);
  });

  it('integer: returns number or NaN; undefined when absent', () => {
    const spec = { wave: { type: 'integer' } };
    assert.equal(defineFlags(spec, []).values.wave, undefined);
    assert.equal(defineFlags(spec, ['--wave', '0']).values.wave, 0);
    assert.equal(defineFlags(spec, ['--wave', '7']).values.wave, 7);
    assert.ok(Number.isNaN(defineFlags(spec, ['--wave', 'oops']).values.wave));
  });

  it('string: passes through raw value or undefined', () => {
    const spec = { gate: { type: 'string' } };
    assert.equal(defineFlags(spec, []).values.gate, undefined);
    assert.equal(defineFlags(spec, ['--gate', 'gate1']).values.gate, 'gate1');
  });

  it('string-multi: returns array, [] when absent, supports repeats', () => {
    const spec = { paths: { type: 'string-multi' } };
    assert.deepEqual(defineFlags(spec, []).values.paths, []);
    assert.deepEqual(
      defineFlags(spec, ['--paths', 'a', '--paths', 'b']).values.paths,
      ['a', 'b'],
    );
  });
});

describe('defineFlags — output keying', () => {
  it('camelCases kebab flag names by default', () => {
    const spec = {
      'base-ref': { type: 'string' },
      'pr-number': { type: 'ticket' },
      'skip-label': { type: 'boolean' },
    };
    const { values } = defineFlags(spec, [
      '--base-ref',
      'origin/main',
      '--pr-number',
      '12',
      '--skip-label',
    ]);
    assert.equal(values.baseRef, 'origin/main');
    assert.equal(values.prNumber, 12);
    assert.equal(values.skipLabel, true);
  });

  it('honors explicit alias over the camelCase default', () => {
    const spec = {
      story: { type: 'ticket', alias: 'storyId' },
      epic: { type: 'ticket', alias: 'epicId' },
    };
    const { values } = defineFlags(spec, ['--story', '5', '--epic', '7']);
    assert.equal(values.storyId, 5);
    assert.equal(values.epicId, 7);
    assert.equal(values.story, undefined);
  });
});

describe('defineFlags — env-var fallbacks', () => {
  it('falls back to envKey when the flag is absent', () => {
    const spec = {
      story: { type: 'ticket', alias: 'storyId', envKey: 'FRICTION_STORY_ID' },
    };
    const { values } = defineFlags(spec, [], {
      env: { FRICTION_STORY_ID: '99' },
    });
    assert.equal(values.storyId, 99);
  });

  it('flag takes precedence over envKey', () => {
    const spec = {
      story: { type: 'ticket', alias: 'storyId', envKey: 'FRICTION_STORY_ID' },
    };
    const { values } = defineFlags(spec, ['--story', '12'], {
      env: { FRICTION_STORY_ID: '99' },
    });
    assert.equal(values.storyId, 12);
  });

  it('envKey is ignored when env value is empty', () => {
    const spec = {
      story: { type: 'ticket', alias: 'storyId', envKey: 'FRICTION_STORY_ID' },
    };
    const { values } = defineFlags(spec, [], {
      env: { FRICTION_STORY_ID: '' },
    });
    assert.equal(values.storyId, null);
  });
});

describe('defineFlags — defaults', () => {
  it('applies default when value is undefined', () => {
    const spec = { 'base-ref': { type: 'string', default: 'origin/main' } };
    assert.equal(defineFlags(spec, []).values.baseRef, 'origin/main');
    assert.equal(
      defineFlags(spec, ['--base-ref', 'origin/develop']).values.baseRef,
      'origin/develop',
    );
  });

  it('applies default when ticket parses to null', () => {
    const spec = { story: { type: 'ticket', alias: 'storyId', default: null } };
    assert.equal(defineFlags(spec, []).values.storyId, null);
    assert.equal(defineFlags(spec, ['--story', 'abc']).values.storyId, null);
  });
});

describe('defineFlags — optionalValue', () => {
  it('uses optionalValue when flag is present without a value', () => {
    const spec = {
      'changed-since': {
        type: 'string',
        alias: 'changedSinceRef',
        optionalValue: 'main',
      },
    };
    const { values } = defineFlags(spec, ['--changed-since']);
    assert.equal(values.changedSinceRef, 'main');
  });

  it('uses provided value when flag has one', () => {
    const spec = {
      'changed-since': {
        type: 'string',
        alias: 'changedSinceRef',
        optionalValue: 'main',
      },
    };
    const { values } = defineFlags(spec, ['--changed-since', 'origin/develop']);
    assert.equal(values.changedSinceRef, 'origin/develop');
  });

  it('does not consume the next --flag as the value', () => {
    const spec = {
      'changed-since': {
        type: 'string',
        alias: 'changedSinceRef',
        optionalValue: 'main',
      },
      epic: { type: 'ticket', alias: 'epicId' },
    };
    const { values } = defineFlags(spec, ['--changed-since', '--epic', '14']);
    assert.equal(values.changedSinceRef, 'main');
    assert.equal(values.epicId, 14);
  });

  it('returns undefined when the flag is absent (no default set)', () => {
    const spec = {
      'changed-since': {
        type: 'string',
        alias: 'changedSinceRef',
        optionalValue: 'main',
      },
    };
    assert.equal(defineFlags(spec, []).values.changedSinceRef, undefined);
  });
});

describe('defineFlags — positionals', () => {
  it('returns leftover positional arguments', () => {
    const spec = { story: { type: 'ticket', alias: 'storyId' } };
    const { positionals } = defineFlags(spec, [
      '--story',
      '5',
      'extra1',
      'extra2',
    ]);
    assert.deepEqual(positionals, ['extra1', 'extra2']);
  });
});

describe('defineFlags — validation', () => {
  it('throws on unknown flag type', () => {
    assert.throws(
      () => defineFlags({ thing: { type: 'mystery' } }, []),
      /unsupported type/,
    );
  });
});

describe('defineFlags — inline `--flag=value` syntax', () => {
  it('string: --flag=value sets the value without consuming a second arg', () => {
    const spec = { gate: { type: 'string' }, story: { type: 'ticket' } };
    const { values, positionals } = defineFlags(spec, [
      '--gate=gate2',
      '--story=#7',
      'leftover',
    ]);
    assert.equal(values.gate, 'gate2');
    assert.equal(values.story, 7);
    assert.deepEqual(positionals, ['leftover']);
  });

  it('integer: --wave=0 honors the inline zero', () => {
    const { values } = defineFlags({ wave: { type: 'integer' } }, ['--wave=0']);
    assert.equal(values.wave, 0);
  });

  it('string-multi: --paths=a appends like the spaced form', () => {
    const spec = { paths: { type: 'string-multi' } };
    const { values } = defineFlags(spec, ['--paths=a', '--paths', 'b']);
    assert.deepEqual(values.paths, ['a', 'b']);
  });
});

describe('defineFlags — argv shapes the parser tolerates', () => {
  it('unknown long flag is skipped (strict: false semantics)', () => {
    const spec = { story: { type: 'ticket' } };
    const { values, positionals } = defineFlags(spec, [
      '--unknown',
      '--story',
      '5',
    ]);
    assert.equal(values.story, 5);
    assert.deepEqual(positionals, []);
  });

  it('a bare `--` terminator forwards the rest as positionals', () => {
    const spec = { story: { type: 'ticket' } };
    const { values, positionals } = defineFlags(spec, [
      '--story',
      '5',
      '--',
      '--story',
      '99',
    ]);
    assert.equal(values.story, 5);
    assert.deepEqual(positionals, ['--story', '99']);
  });

  it('short `-h` resolves through the spec.short map', () => {
    const spec = { help: { type: 'boolean', short: 'h' } };
    assert.equal(defineFlags(spec, ['-h']).values.help, true);
  });

  it('short flag with no spec mapping falls through to positionals', () => {
    const spec = { help: { type: 'boolean' } };
    const { values, positionals } = defineFlags(spec, ['-x']);
    assert.equal(values.help, false);
    assert.deepEqual(positionals, ['-x']);
  });

  it('plain positional preceding a flag is preserved in order', () => {
    const spec = { gate: { type: 'string' } };
    const { positionals, values } = defineFlags(spec, [
      'first',
      '--gate',
      'g1',
      'second',
    ]);
    assert.equal(values.gate, 'g1');
    assert.deepEqual(positionals, ['first', 'second']);
  });
});

describe('defineFlags — env fallback for non-ticket types', () => {
  it('string envKey populates an absent flag', () => {
    const spec = {
      'base-ref': { type: 'string', envKey: 'BASE_REF' },
    };
    const { values } = defineFlags(spec, [], { env: { BASE_REF: 'origin/x' } });
    assert.equal(values.baseRef, 'origin/x');
  });

  it('integer envKey coerces via Number', () => {
    const spec = { wave: { type: 'integer', envKey: 'WAVE_INDEX' } };
    const { values } = defineFlags(spec, [], { env: { WAVE_INDEX: '4' } });
    assert.equal(values.wave, 4);
  });

  it('string-multi envKey seeds a one-element array', () => {
    const spec = { paths: { type: 'string-multi', envKey: 'EXTRA_PATHS' } };
    const { values } = defineFlags(spec, [], {
      env: { EXTRA_PATHS: 'src/foo.js' },
    });
    assert.deepEqual(values.paths, ['src/foo.js']);
  });

  it('flag wins over envKey for non-ticket types', () => {
    const spec = { gate: { type: 'string', envKey: 'GATE' } };
    const { values } = defineFlags(spec, ['--gate', 'arg'], {
      env: { GATE: 'env' },
    });
    assert.equal(values.gate, 'arg');
  });

  it('envKey is ignored when flag matches absent-shape but env entry is non-string', () => {
    const spec = { gate: { type: 'string', envKey: 'GATE' } };
    // Simulate a runtime where the env bag has a non-string for this key.
    const { values } = defineFlags(spec, [], {
      env: { GATE: undefined },
    });
    assert.equal(values.gate, undefined);
  });
});
