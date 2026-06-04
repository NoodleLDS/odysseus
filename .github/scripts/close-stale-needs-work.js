// @ts-check
'use strict';

/** @param {{ github: import('@octokit/rest').Octokit, context: import('@actions/github').context, core: import('@actions/core') }} */
module.exports = async ({ github, context, core }) => {
  const owner = context.repo.owner;
  const repo  = context.repo.repo;

  const MARKER         = '<!-- pr-needs-work-bot -->';
  const LABEL          = 'needs work';
  const WARN_AFTER_MS  = 5 * 24 * 60 * 60 * 1000;  // 5 days idle → post warning
  const CLOSE_AFTER_MS = 1 * 24 * 60 * 60 * 1000;  // 24 h after warning → close

  // ── Fetch all open PRs carrying the needs-work label ─────────────────────

  async function fetchNeedsWorkPRs() {
    const query = `
      query($owner: String!, $repo: String!, $label: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(
            states: [OPEN]
            labels: [$label]
            first: 100
            after: $cursor
            orderBy: { field: UPDATED_AT, direction: ASC }
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              updatedAt
              author { login ... on Bot { __typename } }
            }
          }
        }
      }
    `;

    const results = [];
    let cursor = null;
    do {
      const { repository } = await github.graphql(query, { owner, repo, label: LABEL, cursor });
      const page = repository.pullRequests;
      results.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    return results;
  }

  async function findBotComment(prNumber) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100,
    });
    return comments.find(c => (c.body ?? '').includes(MARKER)) ?? null;
  }

  function warningComment() {
    return [
      MARKER,
      '⏳ **This PR has been waiting for updates for 5 days**',
      '',
      'A maintainer has requested changes (the `needs work` label is set) but there',
      'has been no activity for a while.',
      '',
      '**If you are still working on it:** push a commit or leave a comment and this',
      'notice will be removed automatically.',
      '',
      '**If you are no longer able to address the feedback:** feel free to close the',
      'PR — someone else can pick it up from your branch later if needed.',
      '',
      'This PR will be closed automatically in 24 hours if there is no further activity.',
      '',
      '_This comment is removed automatically if the PR is updated._',
    ].join('\n');
  }

  const CLOSING_COMMENT =
    'This PR has been closed automatically after 6 days without activity following a\n' +
    '`needs work` review. No worries — the branch is still there if you want to pick\n' +
    'it up later. Feel free to reopen once the requested changes are addressed.';

  // ── Per-PR state machine ──────────────────────────────────────────────────
  //
  // Three mutually exclusive cases:
  //   Case 1 — author responded: warning exists AND updatedAt > warning.created_at
  //            → delete warning, leave PR open
  //   Case 2 — close:           warning exists AND 24 h elapsed with no update
  //            → post closing comment, close PR
  //   Case 3 — warn:            no warning yet AND PR idle ≥ 5 days
  //            → post 24-h warning

  async function handlePR(pr) {
    const now              = Date.now();
    const updatedAt        = new Date(pr.updatedAt).getTime();
    const idleSinceUpdate  = now - updatedAt;
    const idleHours        = Math.round(idleSinceUpdate / 3_600_000);

    core.info(`PR #${pr.number}: idle ${idleHours}h since last update.`);

    const existing = await findBotComment(pr.number);

    if (existing) {
      const warnedAt        = new Date(existing.created_at).getTime();
      const idleSinceWarn   = now - warnedAt;

      // Case 1: PR was updated after the warning — author responded.
      if (updatedAt > warnedAt) {
        await github.rest.issues.deleteComment({ owner, repo, comment_id: existing.id });
        core.info(`PR #${pr.number}: updated after warning — removed stale notice.`);
        return;
      }

      // Case 2: 24 h have passed since the warning with no activity → close.
      if (idleSinceWarn >= CLOSE_AFTER_MS) {
        await github.rest.issues.createComment({
          owner, repo, issue_number: pr.number, body: CLOSING_COMMENT,
        });
        await github.rest.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' });
        core.info(`PR #${pr.number}: closed after 6-day inactivity.`);
        return;
      }

      core.info(`PR #${pr.number}: warning posted, 24-h window not yet elapsed.`);
      return;
    }

    // Case 3: No warning yet — post one if idle for ≥ 5 days.
    if (idleSinceUpdate >= WARN_AFTER_MS) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: pr.number, body: warningComment(),
      });
      core.info(`PR #${pr.number}: posted 5-day inactivity warning.`);
      return;
    }

    core.info(`PR #${pr.number}: within grace period — no action.`);
  }

  // ── Main ──────────────────────────────────────────────────────────────────

  const prs = await fetchNeedsWorkPRs();
  core.info(`Found ${prs.length} open PR(s) with label "${LABEL}".`);

  for (const pr of prs) {
    if (pr.author?.__typename === 'Bot') continue;
    await handlePR(pr);
  }

  core.info('Scan complete.');
};
