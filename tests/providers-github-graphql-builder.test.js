/**
 * Tests for providers/github/graphql-builder.js.
 *
 * Exercises each exported query / mutation string and the lookup builder.
 * Focus is on shape — each export must declare the right operation type
 * (query/mutation) and reference the variables it binds — rather than
 * exact whitespace.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const builder = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'graphql-builder.js',
    ),
  ).href
);

describe('graphql-builder — sub-issue operations', () => {
  it('SUB_ISSUES_QUERY paginates via cursor and selects ticket fields', () => {
    assert.match(builder.SUB_ISSUES_QUERY, /^query\(/);
    assert.match(builder.SUB_ISSUES_QUERY, /\$id: ID!/);
    assert.match(builder.SUB_ISSUES_QUERY, /\$cursor: String/);
    assert.match(
      builder.SUB_ISSUES_QUERY,
      /subIssues\(first: 100, after: \$cursor\)/,
    );
    for (const field of ['number', 'databaseId', 'title', 'body', 'state']) {
      assert.ok(
        builder.SUB_ISSUES_QUERY.includes(field),
        `SUB_ISSUES_QUERY must select ${field}`,
      );
    }
  });

  it('ADD_SUB_ISSUE_MUTATION binds replaceParent', () => {
    assert.match(builder.ADD_SUB_ISSUE_MUTATION, /mutation\(/);
    assert.match(builder.ADD_SUB_ISSUE_MUTATION, /\$replaceParent: Boolean/);
    assert.match(builder.ADD_SUB_ISSUE_MUTATION, /addSubIssue\(input:/);
  });

  it('REMOVE_SUB_ISSUE_MUTATION targets removeSubIssue', () => {
    assert.match(builder.REMOVE_SUB_ISSUE_MUTATION, /mutation\(/);
    assert.match(builder.REMOVE_SUB_ISSUE_MUTATION, /removeSubIssue\(input:/);
  });
});

describe('graphql-builder — projects lookup', () => {
  it('OWNER_NODE_LOOKUP_QUERY queries user and organization', () => {
    assert.match(builder.OWNER_NODE_LOOKUP_QUERY, /user\(login: \$login\)/);
    assert.match(
      builder.OWNER_NODE_LOOKUP_QUERY,
      /organization\(login: \$login\)/,
    );
  });

  it('buildProjectV2LookupQuery injects the type and fragment', () => {
    const userQ = builder.buildProjectV2LookupQuery('user', 'id title');
    const orgQ = builder.buildProjectV2LookupQuery('organization', 'id');
    assert.match(userQ, /user\(login: \$owner\)/);
    assert.match(userQ, /projectV2\(number: \$number\) \{ id title \}/);
    assert.match(orgQ, /organization\(login: \$owner\)/);
    assert.match(orgQ, /projectV2\(number: \$number\) \{ id \}/);
  });
});

describe('graphql-builder — project mutations', () => {
  it('ADD_PROJECT_ITEM_MUTATION adds to a projectV2', () => {
    assert.match(builder.ADD_PROJECT_ITEM_MUTATION, /mutation\(/);
    assert.match(
      builder.ADD_PROJECT_ITEM_MUTATION,
      /addProjectV2ItemById\(input:/,
    );
  });

  it('CREATE_PROJECT_MUTATION creates a projectV2', () => {
    assert.match(builder.CREATE_PROJECT_MUTATION, /mutation\(/);
    assert.match(builder.CREATE_PROJECT_MUTATION, /createProjectV2\(input:/);
  });

  it('CREATE_SINGLE_SELECT_FIELD_MUTATION uses SINGLE_SELECT', () => {
    assert.match(
      builder.CREATE_SINGLE_SELECT_FIELD_MUTATION,
      /dataType: SINGLE_SELECT/,
    );
    assert.match(
      builder.CREATE_SINGLE_SELECT_FIELD_MUTATION,
      /createProjectV2Field\(input:/,
    );
  });

  it('UPDATE_SINGLE_SELECT_FIELD_MUTATION targets updateProjectV2Field', () => {
    assert.match(
      builder.UPDATE_SINGLE_SELECT_FIELD_MUTATION,
      /updateProjectV2Field\(input:/,
    );
  });

  it('CREATE_PROJECT_VIEW_MUTATION uses BOARD_LAYOUT', () => {
    assert.match(builder.CREATE_PROJECT_VIEW_MUTATION, /layout: BOARD_LAYOUT/);
  });
});

describe('graphql-builder — fragments', () => {
  it('STATUS_FIELD_FRAGMENT selects single-select options', () => {
    assert.match(builder.STATUS_FIELD_FRAGMENT, /ProjectV2SingleSelectField/);
    assert.match(builder.STATUS_FIELD_FRAGMENT, /options \{ id name \}/);
  });

  it('PROJECT_VIEWS_FRAGMENT selects view names', () => {
    assert.match(builder.PROJECT_VIEWS_FRAGMENT, /views\(first: 50\)/);
  });

  it('PROJECT_FIELDS_FRAGMENT covers all three field types', () => {
    assert.match(builder.PROJECT_FIELDS_FRAGMENT, /ProjectV2Field/);
    assert.match(builder.PROJECT_FIELDS_FRAGMENT, /ProjectV2IterationField/);
    assert.match(builder.PROJECT_FIELDS_FRAGMENT, /ProjectV2SingleSelectField/);
  });
});
