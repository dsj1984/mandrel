/**
 * tests/cli/postinstall.test.js — unit tests for bin/postinstall.js
 *
 * The published-package `postinstall` hook (Story #3469) MUST run
 * `mandrel sync` best-effort and exit 0 even when the sync fails, logging a
 * "run `mandrel sync`" hint so `--ignore-scripts` / sandboxed installs degrade
 * to the doctor-detected state instead of failing the consumer's install.
 *
 * The source-checkout guard (Story #3489) adds a no-op short-circuit: when the
 * hook runs inside the Mandrel framework source repo (root
 * `package.json#name === "@mandrel/agents"`), it MUST skip the materializer
 * entirely so `mandrel sync` never clobbers the committed `.agents/` source —
 * even under `npm install --ignore-scripts=false`.
 *
 * Tests drive `runPostinstall` through its injectable seams (`sync`,
 * `isSourceCheckout`, `writeErr`, `exit`) and `isSourceCheckout` through its
 * `fs` / `moduleUrl` seams, so no real package resolution, filesystem I/O, or
 * process exit occurs (testing-standards § Unit). The consumer-path suites
 * inject `isSourceCheckout: () => false` to isolate the materializer behaviour
 * from the source-checkout guard.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSourceCheckout, runPostinstall } from '../../bin/postinstall.js';

// Consumer install: force the source-checkout guard off so these suites
// exercise the materializer path in isolation.
const consumer = { isSourceCheckout: () => false };

describe('postinstall hook — success path', () => {
  it('invokes the sync materializer', () => {
    let called = false;
    runPostinstall({
      ...consumer,
      sync: () => {
        called = true;
      },
      writeErr: () => {},
      exit: () => {},
    });
    assert.equal(called, true);
  });

  it('exits 0 when sync succeeds', () => {
    let exitCode;
    runPostinstall({
      ...consumer,
      sync: () => {},
      writeErr: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 0);
  });

  it('does not log a hint when sync succeeds', () => {
    let hint = '';
    runPostinstall({
      ...consumer,
      sync: () => {},
      writeErr: (s) => {
        hint += s;
      },
      exit: () => {},
    });
    assert.equal(hint, '');
  });
});

describe('postinstall hook — sync reports non-zero exit (e.g. package missing)', () => {
  it('still exits 0 (best-effort: never fail the install)', () => {
    let exitCode;
    runPostinstall({
      ...consumer,
      // Mimic runSync's missing-package path, which calls its injected exit(1).
      sync: ({ exit }) => exit(1),
      writeErr: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 0);
  });

  it('logs a "run `mandrel sync`" hint', () => {
    let hint = '';
    runPostinstall({
      ...consumer,
      sync: ({ exit }) => exit(1),
      writeErr: (s) => {
        hint += s;
      },
      exit: () => {},
    });
    assert.match(hint, /mandrel sync/);
  });
});

describe('postinstall hook — sync throws (e.g. mid-copy fault)', () => {
  it('swallows the throw and exits 0', () => {
    let exitCode;
    runPostinstall({
      ...consumer,
      sync: () => {
        throw new Error('boom');
      },
      writeErr: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 0);
  });

  it('logs the remediation hint after a thrown error', () => {
    let hint = '';
    runPostinstall({
      ...consumer,
      sync: () => {
        throw new Error('boom');
      },
      writeErr: (s) => {
        hint += s;
      },
      exit: () => {},
    });
    assert.match(hint, /mandrel sync/);
  });
});

describe('postinstall hook — source-checkout guard (Story #3489)', () => {
  it('does NOT invoke the materializer in the framework source checkout', () => {
    let called = false;
    runPostinstall({
      isSourceCheckout: () => true,
      sync: () => {
        called = true;
      },
      writeErr: () => {},
      exit: () => {},
    });
    assert.equal(called, false);
  });

  it('exits 0 (clean no-op, never fails the install)', () => {
    let exitCode;
    runPostinstall({
      isSourceCheckout: () => true,
      sync: () => {},
      writeErr: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 0);
  });

  it('does not log the degraded-state hint (the no-op is expected, not a failure)', () => {
    let hint = '';
    runPostinstall({
      isSourceCheckout: () => true,
      sync: () => {},
      writeErr: (s) => {
        hint += s;
      },
      exit: () => {},
    });
    assert.equal(hint, '');
  });

  it('reports skipped: true in the returned outcome', () => {
    const outcome = runPostinstall({
      isSourceCheckout: () => true,
      sync: () => {},
      writeErr: () => {},
      exit: () => {},
    });
    assert.deepEqual(outcome, { exitCode: 0, hinted: false, skipped: true });
  });
});

describe('isSourceCheckout — repo-root package.json#name detection', () => {
  // The SUT resolves the probed file as dirname(fileURLToPath(moduleUrl))
  // joined with '..'. We point moduleUrl at this test file's own URL so
  // `fileURLToPath` produces a valid path on every platform; the fake fs keys
  // off the package.json basename rather than the exact directory.
  const moduleUrl = import.meta.url;

  const makeFs = (contents) => ({
    readFileSync: (p) => {
      const norm = String(p).replace(/\\/g, '/');
      if (norm.endsWith('package.json') && contents !== null) return contents;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });

  it('returns true when root package.json#name is @mandrel/agents', () => {
    const fs = makeFs(JSON.stringify({ name: '@mandrel/agents' }));
    assert.equal(isSourceCheckout({ fs, moduleUrl }), true);
  });

  it('returns false when root package.json#name is a consumer project', () => {
    const fs = makeFs(JSON.stringify({ name: 'my-consumer-app' }));
    assert.equal(isSourceCheckout({ fs, moduleUrl }), false);
  });

  it('fails safe (false) when package.json is unreadable', () => {
    const fs = makeFs(null);
    assert.equal(isSourceCheckout({ fs, moduleUrl }), false);
  });

  it('fails safe (false) when package.json is malformed JSON', () => {
    const fs = makeFs('{ not valid json');
    assert.equal(isSourceCheckout({ fs, moduleUrl }), false);
  });
});
