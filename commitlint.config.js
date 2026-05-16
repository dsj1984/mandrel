// Conventional Commits enforcement. Run via the `commit-msg` Husky hook
// (see `.husky/commit-msg`). The `type-enum` mirrors the types listed in
// `release-please-config.json` → `changelog-sections` so commitlint and the
// release tooling agree on what's a valid type.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'docs',
        'style',
        'chore',
        'test',
        'build',
        'ci',
      ],
    ],
  },
};
