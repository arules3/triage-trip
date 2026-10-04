import { simpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';

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

const BINARY_EXTENSIONS = new Set([
  '.gif', '.png', '.jpg', '.jpeg', '.cast', '.ico', '.pdf', '.zip',
  '.tar', '.gz', '.db', '.sqlite', '.sqlite3', '.bin', '.wasm'
]);

/**
 * Collects active working copy text for relevant files with line numbers.
 * Gives the LLM exact source of truth for current file state, eliminating hallucinated diffs.
 */
function collectActiveFiles(status, commitDiffs, errorInput = '', maxFiles = 5) {
  const candidates = new Set();

  // 1. Extract file paths from error input / stack trace
  if (errorInput) {
    const fileMatches = errorInput.match(/(?:[a-zA-Z0-9_\-\.\/]+\/)?([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)/g) || [];
    for (const match of fileMatches) {
      const cleanPath = match.replace(/^(?:file:\/\/\/|\/)/, '');
      candidates.add(cleanPath);
      candidates.add(path.basename(cleanPath));
    }
  }

  // 2. Working tree files from git status
  const statusFiles = [
    ...(status.modified || []),
    ...(status.staged || []),
    ...(status.created || []),
    ...(status.not_added || []),
  ];
  for (const f of statusFiles) candidates.add(f);

  // 3. Files from latest commit diff
  if (commitDiffs.length > 0 && commitDiffs[0].diff) {
    const diffFiles = commitDiffs[0].diff.match(/(?:---|\+\+\+)\s+[ab]\/([^\s\n]+)/g) || [];
    for (const df of diffFiles) {
      const p = df.replace(/^(?:---|\+\+\+)\s+[ab]\//, '');
      candidates.add(p);
    }
  }

  const activeFiles = {};
  let count = 0;

  for (const candidate of candidates) {
    if (count >= maxFiles) break;

    // Resolve file
    let fullPath = path.resolve(process.cwd(), candidate);
    if (!fs.existsSync(fullPath)) {
      // Try resolving by basename in workspace
      const baseName = path.basename(candidate);
      const found = findCandidateFile(process.cwd(), baseName);
      if (found) fullPath = found;
      else continue;
    }

    const ext = path.extname(fullPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    if (fullPath.includes('node_modules') || fullPath.includes('.git')) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size > 50000) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const relPath = path.relative(process.cwd(), fullPath);

      const lines = content.split('\n');
      const formatted = lines
        .slice(0, 150)
        .map((line, idx) => `${idx + 1}| ${line}`)
        .join('\n');

      activeFiles[relPath] = formatted;
      count++;

      // Also inspect relative local imports for JS/TS
      if (['.js', '.ts', '.jsx', '.tsx', '.mjs'].includes(ext)) {
        const importMatches = content.match(/(?:import|require)\s*\(?['"](\.[^'"]+)['"]/g) || [];
        for (const imp of importMatches) {
          const importRel = imp.match(/['"](\.[^'"]+)['"]/)?.[1];
          if (importRel) {
            const dir = path.dirname(fullPath);
            let importedPath = path.resolve(dir, importRel);
            if (!fs.existsSync(importedPath) && fs.existsSync(importedPath + '.js')) {
              importedPath = importedPath + '.js';
            }
            if (fs.existsSync(importedPath) && !activeFiles[path.relative(process.cwd(), importedPath)]) {
              candidates.add(path.relative(process.cwd(), importedPath));
            }
          }
        }
      }
    } catch {}
  }

  return activeFiles;
}

function findCandidateFile(dir, baseName, depth = 0) {
  if (depth > 4) return null;
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.cache', 'coverage']);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!ignored.has(ent.name)) {
          const found = findCandidateFile(path.join(dir, ent.name), baseName, depth + 1);
          if (found) return found;
        }
      } else if (ent.isFile() && ent.name === baseName) {
        return path.join(dir, ent.name);
      }
    }
  } catch {}
  return null;
}

export async function getRecentChanges(maxCommits = 3, errorInput = '') {
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
    ':!assets/*',
    ':!*.gif',
    ':!*.cast',
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

  const activeFileContents = collectActiveFiles(status, commitDiffs, errorInput);

  return {
    branch: status.current,
    untrackedFiles: status.not_added,
    workingDiff: sanitizeDiff(combinedWorkingDiff) || null,
    recentCommits: commitDiffs,
    activeFileContents,
  };
}
