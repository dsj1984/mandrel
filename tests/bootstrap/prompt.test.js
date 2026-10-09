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
  collectAnswers,
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

describe('collectAnswers silentAccept', () => {
  const BASE_QUESTIONS = [
    {
      key: 'owner',
      flag: 'owner',
      env: 'GH_OWNER',
      message: 'owner',
      default: 'acme',
      required: true,
    },
    {
      key: 'repo',
      flag: 'repo',
      env: 'GH_REPO',
      message: 'repo',
      default: 'widget',
      required: true,
    },
    {
      key: 'projectNumber',
      flag: 'project-number',
      env: 'GH_PROJECT_NUMBER',
      message: 'project number',
      default: null,
      required: false,
    },
  ];

  it('accepts silentAccept keys silently and never opens readline', async () => {
    const writes = [];
    const output = { write: (chunk) => writes.push(chunk) };
    const failingInput = {
      // readline would consume from this; if we ever touch it the test
      // should hang or throw — using a sentinel object proves we didn't.
      on: () => {
        throw new Error('input must not be read when silentAccept is set');
      },
    };
    const { answers, missing } = await collectAnswers({
      questions: BASE_QUESTIONS.filter((q) => q.key !== 'projectNumber'),
      flags: {},
      interactive: true,
      assumeYes: false,
      silentAccept: ['owner', 'repo'],
      input: failingInput,
      output,
    });
    assert.deepEqual(answers, { owner: 'acme', repo: 'widget' });
    assert.deepEqual(missing, []);
    assert.deepEqual(writes, []);
  });

  it('prompts only for keys not in silentAccept', async () => {
    // Drive a single readline answer for projectNumber.
    let answeredOnce = false;
    const input = new (await import('node:stream')).PassThrough();
    const output = new (await import('node:stream')).PassThrough();
    output.on('data', (chunk) => {
      if (!answeredOnce && chunk.toString().includes('project number')) {
        answeredOnce = true;
        input.write('42\n');
      }
    });
    const { answers, missing } = await collectAnswers({
      questions: BASE_QUESTIONS,
      flags: {},
      interactive: true,
      assumeYes: false,
      silentAccept: ['owner', 'repo'],
      input,
      output,
    });
    assert.equal(answers.owner, 'acme');
    assert.equal(answers.repo, 'widget');
    assert.equal(answers.projectNumber, '42');
    assert.deepEqual(missing, []);
  });

  it('flag overrides win over silentAccept (no prompt either way)', async () => {
    const failingInput = {
      on: () => {
        throw new Error('input must not be read');
      },
    };
    const output = { write: () => {} };
    const { answers } = await collectAnswers({
      questions: [BASE_QUESTIONS[0]],
      flags: { owner: 'override' },
      interactive: true,
      assumeYes: false,
      silentAccept: ['owner'],
      input: failingInput,
      output,
    });
    assert.equal(answers.owner, 'override');
  });

  it('falls through to the prompt when default is empty even if silentAccept lists the key', async () => {
    const input = new (await import('node:stream')).PassThrough();
    const output = new (await import('node:stream')).PassThrough();
    output.on('data', (chunk) => {
      if (chunk.toString().includes('owner')) input.write('typed\n');
    });
    const { answers } = await collectAnswers({
      questions: [{ ...BASE_QUESTIONS[0], default: null }],
      flags: {},
      interactive: true,
      assumeYes: false,
      silentAccept: ['owner'],
      input,
      output,
    });
    assert.equal(answers.owner, 'typed');
  });
});

// Story #5584 — explicit Projects V2 skip signals ahead of the default.
describe('projectNumber explicit skip signals', () => {
  const PROJECT_Q = {
    key: 'projectNumber',
    flag: 'project-number',
    env: 'GH_PROJECT_NUMBER',
    skipFlag: 'no-project',
    message: 'project',
    default: 'widget',
    required: false,
  };
  const OWNER_Q = {
    key: 'owner',
    flag: 'owner',
    env: 'GH_OWNER',
    message: 'owner',
    default: 'acme',
    required: true,
  };

  async function resolve(argv, env = {}, questions = [PROJECT_Q]) {
    return collectAnswers({
      questions,
      flags: parseFlags(argv),
      interactive: false,
      assumeYes: true,
      env,
      output: { write: () => {} },
    });
  }

  it('parses --no-project as a known boolean flag', () => {
    assert.equal(parseFlags(['--no-project', 'x'])['no-project'], true);
  });

  it('parses an empty --project-number as true (bare) or "" (inline)', () => {
    assert.equal(
      parseFlags(['--project-number', '', '--dry-run'])['project-number'],
      true,
    );
    assert.equal(parseFlags(['--project-number'])['project-number'], true);
    assert.equal(parseFlags(['--project-number='])['project-number'], '');
  });

  for (const argv of [
    ['--no-project'],
    ['--project-number', ''],
    ['--project-number'],
    ['--project-number='],
    ['--project-number', 'none'],
    ['--project-number=NONE'],
    ['--no-project', '--project-number', 'Roadmap'],
  ]) {
    it(`skips the board for ${JSON.stringify(argv)} despite a default`, async () => {
      const { answers, missing } = await resolve(argv);
      assert.equal(answers.projectNumber, '');
      assert.deepEqual(missing, []);
    });
  }

  for (const value of ['', 'none', ' None ']) {
    it(`skips the board when GH_PROJECT_NUMBER is present as ${JSON.stringify(value)}`, async () => {
      const { answers } = await resolve([], { GH_PROJECT_NUMBER: value });
      assert.equal(answers.projectNumber, '');
    });
  }

  it('falls through to the default when GH_PROJECT_NUMBER is unset', async () => {
    const { answers } = await resolve([], {});
    assert.equal(answers.projectNumber, 'widget');
  });

  it('lets an explicit flag value win over a skip env var', async () => {
    const { answers } = await resolve(['--project-number', '7'], {
      GH_PROJECT_NUMBER: 'none',
    });
    assert.equal(answers.projectNumber, '7');
  });

  it('keeps a non-skip env value as the answer', async () => {
    const { answers } = await resolve([], { GH_PROJECT_NUMBER: 'Roadmap' });
    assert.equal(answers.projectNumber, 'Roadmap');
  });

  it('keeps empty-means-unset for questions without a skipFlag', async () => {
    const { answers } = await resolve(['--owner='], { GH_OWNER: '' }, [
      OWNER_Q,
    ]);
    assert.equal(answers.owner, 'acme');
  });
});
