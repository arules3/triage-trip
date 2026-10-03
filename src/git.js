import { simpleGit } from 'simple-git';

const git = simpleGit();

/**
 * Truncates diff text if it exceeds max character limit to prevent LLM token blowup.
 */
function sanitizeDiff(diffStr, maxChars = 4000) {
  if (!diffStr) return null;
  if (diffStr.length > maxChars) {
    return diffStr.slice(0, maxChars) + '\n\n... [diff truncated for length] ...';
  }
  return diffStr;
}

export async function getRecentChanges(maxCommits = 3) {
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error('Not inside a valid Git repository.');
  }

  const status = await git.status();

  // 1. Capture both unstaged and staged uncommitted diffs (excluding noisy lockfiles)
  const lockfileIgnores = [
    ':!package-lock.json',
    ':!yarn.lock',
    ':!pnpm-lock.yaml',
    ':!bun.lockb',
  ];

  const unstagedDiff = await git.diff(['--', '.', ...lockfileIgnores]);
  const stagedDiff = await git.diff(['--cached', '--', '.', ...lockfileIgnores]);

  let combinedWorkingDiff = '';
  if (stagedDiff) combinedWorkingDiff += `--- STAGED CHANGES ---\n${stagedDiff}\n`;
  if (unstagedDiff) combinedWorkingDiff += `--- UNSTAGED CHANGES ---\n${unstagedDiff}\n`;

  // 2. Fetch commit history with bounded diff size
  const log = await git.log({ maxCount: maxCommits });
  const commitDiffs = await Promise.all(
    log.all.map(async (c) => {
      const rawDiff = await git.show([
        c.hash,
        '-p',
        '--',
        '.',
        ...lockfileIgnores,
      ]);

      return {
        hash: c.hash.slice(0, 7),
        author: c.author_name,
        date: c.date,
        message: c.message,
        diff: sanitizeDiff(rawDiff),
      };
    })
  );

  return {
    branch: status.current,
    untrackedFiles: status.not_added, // Tells the LLM if newly created files exist
    workingDiff: sanitizeDiff(combinedWorkingDiff) || null,
    recentCommits: commitDiffs,
  };
}