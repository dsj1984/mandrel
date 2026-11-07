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

/** Commands that run their argv as a command, each with its valued flags. */
const WRAPPERS = new Map([
  ['env', new Set(['-u'])],
  ['command', new Set()],
  ['nohup', new Set()],
  ['time', new Set()],
  ['exec', new Set()],
  ['builtin', new Set()],
  ['sudo', new Set(['-u', '-g', '-C'])],
  ['xargs', new Set(['-n', '-I', '-L', '-P', '-d', '-s', '-E'])],
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

/** @param {string[]} words drops leading `NAME=value` env prefixes */
function dropEnvPrefixes(words) {
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
}

/**
 * @param {string[]} words argv whose head is a wrapper command
 * @param {Set<string>} valued the wrapper's flags that take a value
 */
function dropWrapper(words, valued) {
  words.shift();
  while (words[0]?.startsWith('-')) {
    words.splice(0, valued.has(words[0]) ? 2 : 1);
  }
}

/** @param {string} segment */
function rawWords(segment) {
  return segment
    .trim()
    .replace(/^[{$]+/, '')
    .split(/\s+/)
    .map((w) => w.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Whitespace tokens of one segment, quotes stripped, env prefixes and
 * wrapper commands (`env`, `sudo`, `xargs`, …) dropped.
 */
function tokens(segment) {
  const words = rawWords(segment);
  for (;;) {
    dropEnvPrefixes(words);
    if (!words.length) return words;
    words[0] = path.posix.basename(words[0]);
    const valued = WRAPPERS.get(words[0]);
    if (!valued) return words;
    dropWrapper(words, valued);
  }
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

/** @param {string[]} args gh argv after `gh api` */
function ghApiRule(args) {
  for (let i = 0; i < args.length; i += 1) {
    const method = /^(?:-X|--method)=?(.*)$/.exec(args[i]);
    const value = method && (method[1] || args[i + 1] || '');
    if (method && value.toUpperCase() !== 'GET') return 'gh api write method';
    if (/^(?:-[fF]|--field|--raw-field|--input)(?:=|$)/.test(args[i])) {
      return 'gh api with request fields';
    }
  }
  return null;
}

/** @param {string[]} args gh argv after `gh` */
function ghRule(args) {
  const [group, verb] = args;
  if ((group === 'issue' || group === 'pr') && GH_WRITE_VERBS.has(verb)) {
    return `gh ${group} ${verb}`;
  }
  if (group === 'label' && GH_LABEL_VERBS.has(verb)) return `gh label ${verb}`;
  return group === 'api' ? ghApiRule(args.slice(1)) : null;
}

/** @param {string} arg true when a sed/perl argv entry edits in place */
function isInPlaceFlag(arg) {
  return (
    /^--in-place(=|$)/.test(arg) ||
    (/^-[A-Za-z]*i/.test(arg) && !/^-M/i.test(arg))
  );
}

/** @param {string[]} words */
function segmentRule(words) {
  const [cmd, ...args] = words;
  if (cmd === 'git') return gitRule(args);
  if (cmd === 'gh') return ghRule(args);
  if (cmd === 'sed' || cmd === 'perl') {
    return args.some(isInPlaceFlag) ? `${cmd} -i` : null;
  }
  if (['npm', 'pnpm', 'yarn'].includes(cmd) && INSTALL_VERBS.has(args[0])) {
    return `${cmd} ${args[0]}`;
  }
  return null;
}

/**
 * Subshells, substitutions and brace groups become segment breaks; a brace
 * only as a whole word, so `{owner}` placeholders and `${VAR}` survive.
 * @param {string} command
 */
function flattenGroups(command) {
  return command
    .replace(/\$\(|[`()]/g, ';')
    .replace(/(^|\s)[{}](?=\s|;|$)/g, '$1;');
}

/** @param {unknown} command */
function checkBash(command) {
  if (typeof command !== 'string') deny('Bash command missing');
  const flat = flattenGroups(command);
  for (const segment of flat.split(/\|\||&&|(?<![&>])&(?![&>])|[;|\n]/)) {
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
