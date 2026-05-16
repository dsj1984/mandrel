/**
 * prompt.test — Story #2074
 *
 * Exercises the flag parser and remote-URL parser. The interactive
 * prompt loop is verified separately in unified-bootstrap.test.js with
 * a mocked stdin/stdout pair.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseFlags,
  parseGitRemoteUrl,
} from '../../.agents/scripts/lib/bootstrap/prompt.js';

describe('parseFlags', () => {
  it('parses --flag value pairs', () => {
    const flags = parseFlags(['--owner', 'acme', '--repo', 'widget']);
    assert.equal(flags.owner, 'acme');
    assert.equal(flags.repo, 'widget');
  });

  it('parses --flag=value form', () => {
    const flags = parseFlags(['--owner=acme', '--repo=widget']);
    assert.equal(flags.owner, 'acme');
    assert.equal(flags.repo, 'widget');
  });

  it('recognises boolean flags without a value', () => {
    const flags = parseFlags(['--assume-yes', '--skip-github']);
    assert.equal(flags['assume-yes'], true);
    assert.equal(flags['skip-github'], true);
  });

  it('ignores positional args', () => {
    const flags = parseFlags(['extra', '--owner', 'acme', 'positional']);
    assert.equal(flags.owner, 'acme');
    assert.equal(Object.keys(flags).length, 1);
  });
});

describe('parseGitRemoteUrl', () => {
  it('parses HTTPS GitHub remotes', () => {
    assert.deepEqual(parseGitRemoteUrl('https://github.com/acme/widget.git'), {
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('parses SSH GitHub remotes', () => {
    assert.deepEqual(parseGitRemoteUrl('git@github.com:acme/widget.git'), {
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('parses URLs without the trailing .git', () => {
    assert.deepEqual(parseGitRemoteUrl('https://github.com/acme/widget'), {
      owner: 'acme',
      repo: 'widget',
    });
  });

  it('returns null for empty / malformed input', () => {
    assert.equal(parseGitRemoteUrl(''), null);
    assert.equal(parseGitRemoteUrl(undefined), null);
    assert.equal(parseGitRemoteUrl('not-a-url'), null);
  });
});
