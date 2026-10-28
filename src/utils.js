const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

const MAX_DIFF_CHARS = 3000;
const MAX_FILE_CHARS = 3000;

function isLockfile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const base = filePath.split(/[/\\]/).pop();
  return LOCKFILE_NAMES.has(base);
}

function truncateDiff(diffStr) {
  if (!diffStr || typeof diffStr !== 'string') return diffStr ?? null;
  if (diffStr.length <= MAX_DIFF_CHARS) return diffStr;
  return diffStr.slice(0, MAX_DIFF_CHARS) + '...[Diff truncated for length]';
}

function truncateFileContent(content) {
  if (!content || typeof content !== 'string') return content;
  if (content.length <= MAX_FILE_CHARS) return content;
  return content.slice(0, MAX_FILE_CHARS) + '...[File truncated for length]';
}

/**
 * Filters lockfiles and truncates large diffs/file contents to keep LLM prompts within context limits.
 */
export function cleanGitContext(gitContext = {}) {
  const untrackedFiles = Array.isArray(gitContext.untrackedFiles)
    ? gitContext.untrackedFiles.filter((f) => !isLockfile(f))
    : gitContext.untrackedFiles;

  const workingDiff = truncateDiff(gitContext.workingDiff);

  const recentCommits = Array.isArray(gitContext.recentCommits)
    ? gitContext.recentCommits.map((commit) => ({
        ...commit,
        diff: truncateDiff(commit?.diff),
      }))
    : gitContext.recentCommits;

  let activeFileContents = gitContext.activeFileContents;
  if (activeFileContents && typeof activeFileContents === 'object') {
    activeFileContents = Object.fromEntries(
      Object.entries(activeFileContents).map(([path, content]) => [
        path,
        truncateFileContent(content),
      ])
    );
  }

  return {
    ...gitContext,
    untrackedFiles,
    workingDiff,
    recentCommits,
    activeFileContents,
  };
}
