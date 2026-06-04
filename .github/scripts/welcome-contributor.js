// @ts-check
'use strict';

/** @param {{ github: import('@octokit/rest').Octokit, context: import('@actions/github').context, core: import('@actions/core') }} */
module.exports = async ({ github, context, core }) => {
  // author_association is provided directly in the event payload — no extra
  // API call needed. FIRST_TIME_CONTRIBUTOR = first PR in this repo;
  // FIRST_TIMER = brand-new GitHub account.
  const association = context.payload.pull_request.author_association;

  if (!['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER'].includes(association)) {
    core.info(`Skipping welcome — author_association is "${association}".`);
    return;
  }

  const { owner, repo } = context.repo;
  const issue_number    = context.payload.pull_request.number;

  const body = [
    '👋 **Welcome, and thanks for your first PR!**',
    '',
    'A few things that will help get this reviewed faster:',
    '',
    '- **Conflicts:** If `main` moves while your PR is open, our bot will comment',
    '  with rebase instructions. A quick rebase unblocks the review immediately.',
    '- **Size matters:** Smaller, focused PRs get reviewed much faster than large',
    '  ones. If this touches many areas, consider splitting it.',
    '- **CI checks:** Make sure the description check passes (the bot will tell you',
    '  if anything is missing). Reviewers skip PRs with failing checks.',
    '- **Duplicates:** Search open PRs before opening a new one —',
    '  `is:pr is:open` in the search bar. Duplicate PRs slow everyone down.',
    '',
    'We review carefully and it can take a few days — hang tight. If you have',
    'questions, drop a comment here.',
    '',
    'Thanks for contributing!',
  ].join('\n');

  await github.rest.issues.createComment({ owner, repo, issue_number, body });
  core.info(`Posted welcome comment on PR #${issue_number}.`);
};
