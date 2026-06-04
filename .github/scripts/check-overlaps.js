// @ts-check
'use strict';

/** @param {{ github: import('@octokit/rest').Octokit, context: import('@actions/github').context, core: import('@actions/core') }} */
module.exports = async ({ github, context, core }) => {
  const owner    = context.repo.owner;
  const repo     = context.repo.repo;
  const prNumber = context.payload.pull_request.number;
  const MARKER   = '<!-- pr-overlap-check-bot -->';

  // Files that are commonly touched by many PRs simultaneously and carry no
  // meaningful overlap signal — exclude them to avoid false positives.
  const SKIP_BASENAMES = new Set([
    'package-lock.json', 'yarn.lock', 'poetry.lock', 'uv.lock',
    'pnpm-lock.yaml', '.gitignore', 'CHANGELOG.md',
  ]);

  function shouldSkip(filePath) {
    return SKIP_BASENAMES.has(filePath.split('/').pop());
  }

  // ── Step 1: get files changed by the incoming PR ─────────────────────────

  const incomingFiles = await github.paginate(
    github.rest.pulls.listFiles,
    { owner, repo, pull_number: prNumber, per_page: 100 },
    res => res.data.map(f => f.filename),
  );
  const incomingSet = new Set(incomingFiles.filter(f => !shouldSkip(f)));

  if (incomingSet.size === 0) {
    core.info('No meaningful files changed — skipping overlap check.');
    return;
  }

  core.info(`PR #${prNumber} touches ${incomingSet.size} file(s).`);

  // ── Step 2: fetch ALL open non-draft PRs with their files via GraphQL ────
  // GraphQL lets us get files for 100 PRs per page instead of one REST call
  // per PR, which keeps rate-limit usage low even at 200+ open PRs.

  const query = `
    query($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(
          states: [OPEN]
          first: 100
          after: $cursor
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number
            title
            isDraft
            author { login ... on User { __typename } }
            files(first: 100) { nodes { path } }
          }
        }
      }
    }
  `;

  const overlapping = [];
  let cursor = null;

  do {
    const { repository } = await github.graphql(query, { owner, repo, cursor });
    const page = repository.pullRequests;

    for (const pr of page.nodes) {
      if (pr.number === prNumber) continue;   // skip self
      if (pr.isDraft) continue;               // drafts are works-in-progress, not competing
      if (pr.author?.__typename === 'Bot') continue;

      const sharedFiles = pr.files.nodes
        .map(f => f.path)
        .filter(p => !shouldSkip(p) && incomingSet.has(p));

      if (sharedFiles.length > 0) {
        overlapping.push({ number: pr.number, title: pr.title, sharedFiles });
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  // ── Step 3: find existing bot comment ────────────────────────────────────

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  const existing = comments.find(c => (c.body ?? '').includes(MARKER));

  // ── Step 4a: no overlap → delete warning if it was there ─────────────────

  if (overlapping.length === 0) {
    if (existing) {
      await github.rest.issues.deleteComment({ owner, repo, comment_id: existing.id });
      core.info(`PR #${prNumber}: overlap cleared — removed warning comment.`);
    } else {
      core.info(`PR #${prNumber}: no overlap found.`);
    }
    return;
  }

  // ── Step 4b: overlap found → post or update comment ──────────────────────

  const lines = overlapping.map(({ number, title, sharedFiles }) => {
    const preview = sharedFiles.slice(0, 5).map(f => `\`${f}\``).join(', ');
    const tail    = sharedFiles.length > 5 ? ` +${sharedFiles.length - 5} more` : '';
    return `- #${number} — ${title} (${sharedFiles.length} shared file(s): ${preview}${tail})`;
  });

  const body = [
    MARKER,
    '⚠️ **Heads up — this PR overlaps with other open PRs**',
    '',
    'The following open PRs modify some of the same files:',
    '',
    ...lines,
    '',
    "This isn't a blocker, but it's worth coordinating with those authors or",
    'checking if any of those PRs address the same issue. If they get merged',
    'first, a rebase will be needed.',
    '',
    '_This comment is updated automatically as PRs open and close._',
  ].join('\n');

  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  }

  core.info(`PR #${prNumber}: flagged overlap with ${overlapping.length} PR(s).`);
};
