#!/usr/bin/env node

/**
 * PreToolUse hook for the reviewer roles (`acceptance-critic`, `auditor`).
 * Reads the hook payload on stdin; exit 0 allows the call, exit 2 denies it
 * with a one-line stderr reason. A write tool may only target the project's
 * tempRoot (or a `.worktrees/<name>/` checkout's); a Bash command is denied
 * when a segment matches a named mutation class. A deny-list, not a sandbox.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getPaths, resolveConfig } from './lib/config-resolver.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const GIT_WRITE_VERBS = new Set(
  'add commit push checkout switch restore reset stash rebase merge cherry-pick revert tag clean rm mv apply am'.split(
    ' ',
  ),
);
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);
const GH_WRITE_VERBS = new Set(
  'create edit close reopen comment merge review ready lock delete'.split(' '),
);
const GH_LABEL_VERBS = new Set(['create', 'edit', 'delete']);
const INSTALL_VERBS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'uninstall',
  'ci',
]);

class Denied extends Error {}

/** @param {string} rule */
function deny(rule) {
  throw new Denied(rule);
}

/** True when `abs` sits strictly below `root`. */
function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {string} target
 * @param {{ projectDir: string, cwd: string, tempRoot: string }} ctx
 */
function checkWriteTarget(target, { projectDir, cwd, tempRoot }) {
  if (typeof target !== 'string' || target === '') {
    deny('write target path missing');
  }
  const posix = target.replace(/\\/g, '/');
  if (process.platform !== 'win32' && /^[A-Za-z]:\//.test(posix)) {
    deny(`write target ${target} is outside ${tempRoot}/`);
  }
  const abs = path.resolve(cwd, posix);
  if (isInside(path.resolve(projectDir, tempRoot), abs)) return;
  const worktrees = path.resolve(projectDir, '.worktrees');
  if (isInside(worktrees, abs)) {
    const name = path.relative(worktrees, abs).split(path.sep)[0];
    if (isInside(path.resolve(worktrees, name, tempRoot), abs)) return;
  }
  deny(`write target ${target} is outside ${tempRoot}/`);
}

/** Whitespace tokens of one segment, quotes stripped, env prefixes dropped. */
function tokens(segment) {
  const words = segment
    .trim()
    .replace(/^[({`$]+/, '')
    .split(/\s+/)
    .map((w) => w.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
  if (words.length) words[0] = path.posix.basename(words[0]);
  return words;
}

/** @param {string[]} args git argv after `git` */
function gitRule(args) {
  let i = 0;
  while (args[i]?.startsWith('-')) i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  const [verb, sub, ...rest] = args.slice(i);
  if (GIT_WRITE_VERBS.has(verb)) return `git ${verb}`;
  if (verb === 'worktree' && ['add', 'remove', 'prune'].includes(sub)) {
    return `git worktree ${sub}`;
  }
  const branchFlags = ['-d', '-D', '-m', '-M', '--delete', '--move'];
  if (verb === 'branch' && [sub, ...rest].some((a) => branchFlags.includes(a)))
    return 'git branch delete/rename';
  return null;
}

/** @param {string[]} args gh argv after `gh` */
function ghRule(args) {
  const [group, verb] = args;
  if ((group === 'issue' || group === 'pr') && GH_WRITE_VERBS.has(verb)) {
    return `gh ${group} ${verb}`;
  }
  if (group === 'label' && GH_LABEL_VERBS.has(verb)) return `gh label ${verb}`;
  if (group !== 'api') return null;
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    const method = /^(?:-X|--method)=?(.*)$/.exec(a);
    if (method) {
      const value = method[1] || args[i + 1] || '';
      if (value.toUpperCase() !== 'GET') return 'gh api write method';
    }
    if (/^(?:-[fF]|--field|--raw-field|--input)(?:=|$)/.test(a)) {
      return 'gh api with request fields';
    }
  }
  return null;
}

/** @param {string[]} words */
function segmentRule(words) {
  const [cmd, ...args] = words;
  if (cmd === 'git') return gitRule(args);
  if (cmd === 'gh') return ghRule(args);
  if (cmd === 'sed' || cmd === 'perl') {
    const inPlace = args.some(
      (a) => a === '--in-place' || (/^-[A-Za-z]*i/.test(a) && !/^-M/i.test(a)),
    );
    return inPlace ? `${cmd} -i` : null;
  }
  if (['npm', 'pnpm', 'yarn'].includes(cmd) && INSTALL_VERBS.has(args[0])) {
    return `${cmd} ${args[0]}`;
  }
  return null;
}

/** @param {unknown} command */
function checkBash(command) {
  if (typeof command !== 'string') deny('Bash command missing');
  for (const segment of command.split(/\|\||&&|[;|\n]/)) {
    const rule = segmentRule(tokens(segment));
    if (rule) deny(`mutation class '${rule}'`);
  }
}

/** @param {any} payload the parsed PreToolUse payload */
function evaluate(payload) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  if (tool === 'Bash') return checkBash(input.command);
  if (!WRITE_TOOLS.has(tool)) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd;
  if (!projectDir) deny('no project directory to scope writes to');
  const { tempRoot } = getPaths(
    resolveConfig({ cwd: projectDir, validate: false }),
  );
  checkWriteTarget(input.file_path ?? input.notebook_path, {
    projectDir,
    cwd: payload.cwd || projectDir,
    tempRoot,
  });
}

/** @returns {Promise<number>} */
async function main() {
  const { values } = parseArgs({ options: { role: { type: 'string' } } });
  const role = values.role ?? 'unknown-role';
  let tool = 'unknown-tool';
  try {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      deny('stdin is not a JSON hook payload (fail closed)');
    }
    tool = payload?.tool_name ?? tool;
    evaluate(payload);
    return 0;
  } catch (err) {
    const rule = err instanceof Denied ? err.message : `guard error: ${err}`;
    process.stderr.write(
      `role-scope-guard: ${role} ${tool} denied — ${rule}\n`,
    );
    return 2;
  }
}

runAsCli(import.meta.url, main, {
  source: 'role-scope-guard',
  propagateExitCode: true,
  exitCode: 2,
  usage: {
    invocation: 'node .agents/scripts/role-scope-guard.js --role <role>',
    summary:
      'PreToolUse hook: deny reviewer-role writes outside tempRoot and Bash mutation classes (exit 2).',
    flags: [['--role <role>', 'The reviewer role named in a deny reason.']],
  },
});
