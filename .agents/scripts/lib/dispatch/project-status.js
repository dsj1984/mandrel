/**
 * Each Story's GitHub Projects v2 `Status` value, read for the board. One
 * aliased GraphQL query per {@link CHUNK} issues reads every issue's project
 * items; the value on the configured project is the Story's Status. A board
 * with no project, a token without the `project` scope, or any failed read
 * degrades to no Status rather than failing the board.
 *
 * @module lib/dispatch/project-status
 */

/** Issues per GraphQL request; well inside GitHub's node limits. */
const CHUNK = 50;

const issueSelection = (id) => `
  i${id}: issue(number: ${id}) {
    projectItems(first: 20) {
      nodes {
        project { number }
        status: fieldValueByName(name: "Status") {
          ... on ProjectV2ItemFieldSingleSelectValue { name }
        }
      }
    }
  }`;

function chunkQuery(ids) {
  return `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {${ids.map(issueSelection).join('')}
    }
  }`;
}

/** The Status name on project `projectNumber`, or `null`. */
function statusOn(issue, projectNumber) {
  const item = (issue?.projectItems?.nodes ?? []).find(
    (node) => node?.project?.number === projectNumber,
  );
  return item?.status?.name ?? null;
}

async function readChunk(provider, ids, { owner, repo, projectNumber }) {
  const data = await provider.graphql(chunkQuery(ids), { owner, repo });
  const repository = data?.repository ?? {};
  return ids.map((id) => [id, statusOn(repository[`i${id}`], projectNumber)]);
}

/**
 * Story id → Status name, for each id with a Status on the configured
 * project. Empty when no project is configured or any read fails.
 *
 * @param {{ graphql?: Function }} provider
 * @param {number[]} ids
 * @param {{ github?: { owner?: string, repo?: string, projectNumber?: number|null } }} config
 * @returns {Promise<Map<number, string>>}
 */
export async function readProjectStatuses(provider, ids, config) {
  const { owner, repo, projectNumber } = config?.github ?? {};
  const wanted = [...new Set(ids)].filter(Number.isInteger);
  if (!projectNumber || !owner || !repo || !provider?.graphql) return new Map();
  const chunks = [];
  for (let i = 0; i < wanted.length; i += CHUNK) {
    chunks.push(wanted.slice(i, i + CHUNK));
  }
  try {
    const read = await Promise.all(
      chunks.map((chunk) =>
        readChunk(provider, chunk, { owner, repo, projectNumber }),
      ),
    );
    return new Map(read.flat().filter(([, status]) => status !== null));
  } catch {
    return new Map();
  }
}
