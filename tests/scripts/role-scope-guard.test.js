/**
 * role-scope-guard.js (Story #5978): the reviewer roles' PreToolUse hook.
 * Exit 0 allows, exit 2 denies with a stderr reason naming role, tool, rule.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(
  __dirname,
  '..',
  '..',
  '.agents',
  'scripts',
  'role-scope-guard.js',
);

let project;

before(() => {
  project = makeTempDir('role-scope-guard-');
  fs.writeFileSync(
    path.join(project, '.agentrc.json'),
    JSON.stringify({ project: { paths: { tempRoot: 'scratch-root' } } }),
  );
});

after(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

function guard(stdin, role = 'auditor') {
  return spawnSync(process.execPath, [GUARD, '--role', role], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
}

const write = (file_path, tool_name = 'Write') => ({
  tool_name,
  cwd: project,
  tool_input: { file_path, content: 'x' },
});
const bash = (command) => ({
  tool_name: 'Bash',
  cwd: project,
  tool_input: { command },
});

function assertDenied(result, pattern) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^role-scope-guard: auditor [\w-]+ denied — /);
  assert.match(result.stderr, pattern);
}

describe('write tools are scoped to the configured tempRoot', {
  concurrency: true,
}, () => {
  it('allows targets under the project or a worktree tempRoot', () => {
    for (const target of [
      path.join(project, 'scratch-root', 'audits', 'r.md'),
      'scratch-root/scratch/story-1/verdict.json',
      path.join(project, '.worktrees', 'story-9', 'scratch-root', 'v.json'),
    ]) {
      for (const tool of ['Write', 'Edit', 'MultiEdit']) {
        const result = guard(write(target, tool));
        assert.equal(result.status, 0, `${tool} ${target}: ${result.stderr}`);
      }
    }
    const nb = guard({
      tool_name: 'NotebookEdit',
      cwd: project,
      tool_input: { notebook_path: 'scratch-root/n.ipynb' },
    });
    assert.equal(nb.status, 0, nb.stderr);
  });

  it('denies targets outside it, traversal and foreign absolutes included', () => {
    for (const target of [
      path.join(project, 'src', 'index.js'),
      'scratch-root/../src/index.js',
      'scratch-root\\..\\src\\index.js',
      path.join(project, '.worktrees', 'story-9', 'src', 'a.js'),
      path.join(project, '.worktrees', 'scratch-root', 'a.js'),
      '/etc/passwd',
      'C:\\Windows\\evil.txt',
      'temp/x.json',
    ]) {
      assertDenied(guard(write(target)), /outside scratch-root\//);
    }
    assertDenied(guard(write(undefined, 'Edit')), /target path missing/);
  });

  it('names the role, tool and rule', () => {
    const result = guard(write('/etc/hosts', 'Edit'), 'acceptance-critic');
    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /^role-scope-guard: acceptance-critic Edit denied — write target \/etc\/hosts is outside scratch-root\/\n$/,
    );
  });
});

describe('Bash mutation classes are denied', { concurrency: true }, () => {
  const denied = {
    'git add -A': 'git add',
    'git commit -m x': 'git commit',
    'git -C /repo push origin HEAD': 'git push',
    'git -c a=b --no-pager reset --hard': 'git reset',
    'git worktree remove .worktrees/x': 'git worktree remove',
    'git branch -D story-1': 'git branch',
    'npm test && git stash': 'git stash',
    'gh issue comment 5 --body hi': 'gh issue comment',
    'gh pr merge 7 --squash': 'gh pr merge',
    'gh label delete foo': 'gh label delete',
    'gh api repos/o/r/issues -X POST': 'gh api write method',
    'gh api --method=PATCH repos/o/r': 'gh api write method',
    'gh api repos/o/r/labels -f name=x': 'gh api with request fields',
    "sed -i '' s/a/b/ f.js": 'sed -i',
    'perl -pi -e s/a/b/ f.js': 'perl -i',
    'cat f | npm install left-pad': 'npm install',
    'FOO=1 pnpm add x': 'pnpm add',
    'echo hi\nyarn remove x': 'yarn remove',
  };
  for (const [command, rule] of Object.entries(denied)) {
    it(`denies ${JSON.stringify(command)}`, () => {
      assertDenied(guard(bash(command)), new RegExp(`'${rule}`));
    });
  }

  const allowed = [
    'git diff main...HEAD',
    'git log --oneline -5',
    'git rev-parse HEAD',
    'git -C /repo status',
    'git branch --show-current',
    'gh issue view 5978 --json body',
    'gh api repos/o/r/issues/1',
    'gh api -X GET repos/o/r',
    'node --test tests/scripts/role-scope-guard.test.js',
    'npm test',
    'sed -n 1,20p f.js',
  ];
  for (const command of allowed) {
    it(`allows ${JSON.stringify(command)}`, () => {
      const result = guard(bash(command));
      assert.equal(result.status, 0, result.stderr);
    });
  }
});

describe('fail closed', { concurrency: true }, () => {
  it('denies unparseable stdin', () => {
    assertDenied(guard('{not json'), /not a JSON hook payload/);
    assertDenied(guard(''), /not a JSON hook payload/);
  });

  it('denies a Bash payload without a command', () => {
    assertDenied(
      guard({ tool_name: 'Bash', tool_input: {} }),
      /Bash command missing/,
    );
  });

  it('allows a tool it does not guard', () => {
    const result = guard({ tool_name: 'Read', tool_input: { file_path: '/' } });
    assert.equal(result.status, 0, result.stderr);
  });

  it('--help prints usage without reading stdin', () => {
    const result = spawnSync(process.execPath, [GUARD, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /role-scope-guard\.js --role <role>/);
  });
});
