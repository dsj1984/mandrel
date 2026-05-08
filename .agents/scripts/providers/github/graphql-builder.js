/**
 * GitHub GraphQL builder — named exports for every GraphQL query and
 * mutation string used by `providers/github.js`. Centralising these strings
 * lets us:
 *
 *   - schema-check each shape in isolation (tests below exercise every
 *     export for a `query`/`mutation` keyword);
 *   - reuse mutations from audit scripts without dragging the provider in;
 *   - keep the provider facade free of inline multi-line template strings.
 *
 * Mutations that build the inner `$type(login:...)` projection at runtime
 * (user-vs-organization project lookups) are exported as builder functions
 * rather than plain strings. Everything else is a plain string constant.
 */

// ---------------------------------------------------------------------------
// Sub-issues (queries + mutations)
// ---------------------------------------------------------------------------

export const SUB_ISSUES_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on Issue {
      subIssues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          databaseId
          id
          title
          body
          state
          labels(first: 30) { nodes { name } }
          assignees(first: 20) { nodes { login } }
        }
      }
    }
  }
}`;

export const ADD_SUB_ISSUE_MUTATION = `
  mutation($parentId: ID!, $subIssueId: ID!, $replaceParent: Boolean) {
    addSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId, replaceParent: $replaceParent }) {
      issue { number }
      subIssue { number }
    }
  }`;

export const REMOVE_SUB_ISSUE_MUTATION = `
  mutation($parentId: ID!, $subIssueId: ID!) {
    removeSubIssue(input: { issueId: $parentId, subIssueId: $subIssueId }) {
      issue { number }
      subIssue { number }
    }
  }`;

// ---------------------------------------------------------------------------
// Projects V2 — owner resolution and project lookup
// ---------------------------------------------------------------------------

export const OWNER_NODE_LOOKUP_QUERY = `query($login: String!) {
  user(login: $login) { id }
  organization(login: $login) { id }
}`;

/**
 * Build the `query($owner, $number) { <type>(login) { projectV2(number) { ... } } }`
 * string for either a user- or organization-scoped lookup.
 */
export function buildProjectV2LookupQuery(type, fragment) {
  return `
      query($owner: String!, $number: Int!) {
        ${type}(login: $owner) {
          projectV2(number: $number) { ${fragment} }
        }
      }
    `;
}

// ---------------------------------------------------------------------------
// Projects V2 — board item management
// ---------------------------------------------------------------------------

export const ADD_PROJECT_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }`;

// ---------------------------------------------------------------------------
// Projects V2 — project / field / view creation
// ---------------------------------------------------------------------------

export const CREATE_PROJECT_MUTATION = `mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: { ownerId: $ownerId, title: $title }) {
    projectV2 { id number }
  }
}`;

export const CREATE_SINGLE_SELECT_FIELD_MUTATION = `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  createProjectV2Field(input: { projectId: $projectId, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name } }
  }
}`;

export const UPDATE_SINGLE_SELECT_FIELD_MUTATION = `mutation($fieldId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: { fieldId: $fieldId, name: $name, singleSelectOptions: $options }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id name } }
  }
}`;

export const CREATE_PROJECT_VIEW_MUTATION = `mutation($projectId: ID!, $name: String!, $filter: String!) {
  createProjectV2View(input: { projectId: $projectId, name: $name, filter: $filter, layout: BOARD_LAYOUT }) {
    projectV2View { id name }
  }
}`;

// ---------------------------------------------------------------------------
// Projects V2 — GraphQL fragments reused across lookups
// ---------------------------------------------------------------------------

export const STATUS_FIELD_FRAGMENT = `
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      `;

export const PROJECT_VIEWS_FRAGMENT = `
        id
        views(first: 50) { nodes { name } }
      `;

export const PROJECT_FIELDS_FRAGMENT = `
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2Field { name }
          ... on ProjectV2IterationField { name }
          ... on ProjectV2SingleSelectField { name }
        }
      }
    `;
