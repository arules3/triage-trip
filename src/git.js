import {simpleGit} from 'simple-git';

const git = simpleGit();

export async function getRecentChanges(maxCommits = 5) {
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error('Not inside a valid Git repository.');
  }

  // Include unstaged/working tree diffs as well
  const status = await git.status();
  const workingDiff = await git.diff();

  const log = await git.log({ maxCount: maxCommits });
  const commitDiffs = await Promise.all(
    log.all.map(async (c) => {
      const diff = await git.show([c.hash, '--stat', '-p']);
      return {
        hash: c.hash.slice(0, 7),
        author: c.author_name,
        date: c.date,
        message: c.message,
        diff,
      };
    })
  );

  return {
    branch: status.current,
    workingDiff: workingDiff || null,
    recentCommits: commitDiffs,
  };
}