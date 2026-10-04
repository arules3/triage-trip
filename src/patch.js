import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';
import traversePkg from '@babel/traverse';

const traverse = traversePkg.default?.default || traversePkg.default || traversePkg;

/**
 * Extracts unified diff text from LLM response.
 * Handles markdown fences (```diff, ```patch, generic ```), raw diffs, and cleans common noise.
 */
export function extractDiff(llmOutput) {
  if (!llmOutput || typeof llmOutput !== 'string') return null;

  // 1. Try markdown code block markers
  const fenceMatch =
    llmOutput.match(/```(?:diff|patch)\s*([\s\S]*?)```/i) ||
    llmOutput.match(/```\s*\n(--- [^\n]+\n\+\+\+ [^\n]+[\s\S]*?)```/) ||
    llmOutput.match(/```\s*\n(diff --git [^\n]+[\s\S]*?)```/);

  let raw = '';
  if (fenceMatch) {
    raw = fenceMatch[1];
  } else {
    // 2. Try raw unified diff pattern
    const rawMatch =
      llmOutput.match(/(diff --git a\/[^\n]+ b\/[^\n]+[\s\S]*)/) ||
      llmOutput.match(/(--- [^\n]+\n\+\+\+ [^\n]+[\s\S]*)/);
    if (rawMatch) {
      raw = rawMatch[1];
    } else {
      return null;
    }
  }

  // Clean non-breaking spaces and Windows newlines
  raw = raw.replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');

  // Strip git index metadata lines if malformed
  raw = raw.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$\n?/gm, '');

  if (!raw.endsWith('\n')) raw += '\n';

  return raw.trim() + '\n';
}

/**
 * Normalizes diff headers and recounts hunk lines (@@ -oldStart,oldCount +newStart,newCount @@).
 * LLMs frequently miscount lines in the hunk header, which causes git apply to fail.
 */
export function normalizeDiff(diffString) {
  if (!diffString) return '';
  const cleaned = diffString.replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');
  const lines = cleaned.split('\n');
  const result = [];

  let currentHunkIdx = -1;
  let oldCount = 0;
  let newCount = 0;
  let inHunk = false;
  let oldStart = 1;
  let newStart = 1;
  let hunkHeaderExtra = '';

  function finalizeHunk() {
    if (currentHunkIdx >= 0) {
      result[currentHunkIdx] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunkHeaderExtra}`;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Normalize header paths: ensure standard a/ and b/ prefixes
    if (line.startsWith('--- ') && !line.startsWith('--- a/') && !line.startsWith('--- /dev/null')) {
      const p = line.slice(4).trim().replace(/^([ab]\/|\.\/)/, '');
      result.push(`--- a/${p}`);
      continue;
    }
    if (line.startsWith('+++ ') && !line.startsWith('+++ b/') && !line.startsWith('+++ /dev/null')) {
      const p = line.slice(4).trim().replace(/^([ab]\/|\.\/)/, '');
      result.push(`+++ b/${p}`);
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      finalizeHunk();
      oldStart = hunkMatch[1];
      newStart = hunkMatch[2];
      hunkHeaderExtra = hunkMatch[3] || '';
      oldCount = 0;
      newCount = 0;
      inHunk = true;
      currentHunkIdx = result.length;
      result.push(line);
      continue;
    }

    if (inHunk) {
      if (line.startsWith('--- ') || line.startsWith('diff --git')) {
        finalizeHunk();
        inHunk = false;
        currentHunkIdx = -1;
        result.push(line);
      } else if (line.startsWith('-')) {
        oldCount++;
        result.push(line);
      } else if (line.startsWith('+')) {
        newCount++;
        result.push(line);
      } else if (line.startsWith(' ') || line === '') {
        oldCount++;
        newCount++;
        result.push(line === '' ? ' ' : line);
      } else if (line.startsWith('\\')) {
        // e.g. \ No newline at end of file
        result.push(line);
      } else {
        finalizeHunk();
        inHunk = false;
        currentHunkIdx = -1;
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }

  finalizeHunk();
  return result.join('\n').trim() + '\n';
}

/**
 * Validates syntax of patched content to prevent breaking the workspace with unparseable code.
 */
export function validateSyntax(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();

  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    try {
      parse(content, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
      });
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  if (ext === '.json') {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  return { valid: true };
}

/**
 * Parses a unified diff string into structured file patches and hunks.
 */
export function parseUnifiedDiff(diffString) {
  const files = [];
  const lines = diffString.split('\n');
  let currentFile = null;
  let currentHunk = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      const rawPath = line.slice(4).trim().split('\t')[0];
      const oldPath = rawPath.replace(/^(?:a\/|\.\/)/, '');
      currentFile = {
        oldPath,
        newPath: '',
        isNew: rawPath === '/dev/null' || rawPath === 'dev/null',
        isDeleted: false,
        hunks: [],
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (line.startsWith('+++ ') && currentFile) {
      const rawPath = line.slice(4).trim().split('\t')[0];
      currentFile.newPath = rawPath.replace(/^(?:b\/|\.\/)/, '');
      currentFile.isDeleted = rawPath === '/dev/null' || rawPath === 'dev/null';
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] || '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] || '1', 10),
        rawLines: [],
        oldLines: [],
        newLines: [],
        removed: [],
        added: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.rawLines.push(line);
        currentHunk.oldLines.push(line.slice(1));
        currentHunk.removed.push(line.slice(1));
      } else if (line.startsWith('+')) {
        currentHunk.rawLines.push(line);
        currentHunk.newLines.push(line.slice(1));
        currentHunk.added.push(line.slice(1));
      } else if (line.startsWith(' ') || line === '') {
        const text = line.startsWith(' ') ? line.slice(1) : line;
        currentHunk.rawLines.push(line);
        currentHunk.oldLines.push(text);
        currentHunk.newLines.push(text);
      }
    }
  }

  return files;
}

/**
 * Resolves a file path from a diff to an actual file on disk.
 */
function resolveFilePath(targetRelPath) {
  if (!targetRelPath || targetRelPath === '/dev/null') return null;

  // 1. Direct path from cwd
  const directPath = path.resolve(process.cwd(), targetRelPath);
  if (fs.existsSync(directPath)) return directPath;

  // 2. Search workspace for matching basename (avoiding noisy directories)
  const baseName = path.basename(targetRelPath);
  const found = findFileByBasename(process.cwd(), baseName);
  if (found) return found;

  return directPath; // return unresolved direct path for creation or not-found handling
}

function findFileByBasename(dir, targetName, depth = 0) {
  if (depth > 5) return null;
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.cache', 'coverage']);

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!ignored.has(ent.name)) {
          const res = findFileByBasename(path.join(dir, ent.name), targetName, depth + 1);
          if (res) return res;
        }
      } else if (ent.isFile() && ent.name === targetName) {
        return path.join(dir, ent.name);
      }
    }
  } catch {}
  return null;
}

/**
 * Computes fast token-based similarity between two lines.
 */
function lineTokenSimilarity(a, b) {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const t1 = s1.split(/[^a-z0-9_$]+/i).filter(Boolean);
  const t2 = s2.split(/[^a-z0-9_$]+/i).filter(Boolean);
  if (t1.length === 0 || t2.length === 0) return 0.0;

  let matches = 0;
  const set2 = new Set(t2);
  for (const t of t1) {
    if (set2.has(t)) matches++;
  }
  return (2 * matches) / (t1.length + t2.length);
}

/**
 * Applies a hunk to an array of file lines using progressive matching tiers.
 * Returns { success: boolean, updatedLines: string[] }.
 */
function applyHunkToLines(fileLines, hunk, targetFilePath) {
  const oldLines = hunk.oldLines;
  const newLines = hunk.newLines;
  const removed = hunk.removed;
  const added = hunk.added;

  // --- Tier 1: Exact oldLines (context + removed) match ---
  if (oldLines.length > 0) {
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (fileLines[i + j] !== oldLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const updated = [...fileLines.slice(0, i), ...newLines, ...fileLines.slice(i + oldLines.length)];
        return { success: true, updatedLines: updated };
      }
    }
  }

  // --- Tier 2: Exact removed-only lines match (ignoring context) ---
  if (removed.length > 0) {
    for (let i = 0; i <= fileLines.length - removed.length; i++) {
      let match = true;
      for (let j = 0; j < removed.length; j++) {
        if (fileLines[i + j] !== removed[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const updated = [...fileLines.slice(0, i), ...added, ...fileLines.slice(i + removed.length)];
        return { success: true, updatedLines: updated };
      }
    }
  }

  // --- Tier 3: Whitespace & indentation normalized match ---
  if (oldLines.length > 0) {
    const normOld = oldLines.map((l) => l.trim());
    for (let i = 0; i <= fileLines.length - normOld.length; i++) {
      let match = true;
      for (let j = 0; j < normOld.length; j++) {
        if (fileLines[i + j].trim() !== normOld[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        // Adapt indentation from original lines
        const indentMatch = fileLines[i].match(/^\s*/);
        const baseIndent = indentMatch ? indentMatch[0] : '';
        const adaptedNew = newLines.map((l) => {
          if (l.trim().length === 0) return '';
          const diffIndent = l.match(/^\s*/)?.[0] || '';
          return diffIndent ? l : baseIndent + l;
        });
        const updated = [...fileLines.slice(0, i), ...adaptedNew, ...fileLines.slice(i + normOld.length)];
        return { success: true, updatedLines: updated };
      }
    }
  }

  // --- Tier 4: Case-insensitive & token similarity match ---
  // Covers cases like `profile.userID` vs `profile.userid` vs `profile.userId`
  if (removed.length > 0) {
    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i <= fileLines.length - removed.length; i++) {
      let totalSim = 0;
      for (let j = 0; j < removed.length; j++) {
        const sim = lineTokenSimilarity(fileLines[i + j], removed[j]);
        totalSim += sim;
      }
      const avgSim = totalSim / removed.length;
      if (avgSim > bestScore) {
        bestScore = avgSim;
        bestIdx = i;
      }
    }

    if (bestScore >= 0.75 && bestIdx >= 0) {
      const indentMatch = fileLines[bestIdx].match(/^\s*/);
      const baseIndent = indentMatch ? indentMatch[0] : '';

      const adaptedAdded = added.map((l) => {
        if (l.trim().length === 0) return '';
        const curIndent = l.match(/^\s*/)?.[0] || '';
        return curIndent ? l : baseIndent + l;
      });

      const updated = [...fileLines.slice(0, bestIdx), ...adaptedAdded, ...fileLines.slice(bestIdx + removed.length)];
      return { success: true, updatedLines: updated };
    }
  }

  // --- Tier 5: AST-guided MemberExpression / Identifier rename for JS/TS ---
  const ext = path.extname(targetFilePath).toLowerCase();
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext) && removed.length === 1 && added.length === 1) {
    const astResult = tryAstMemberRename(fileLines.join('\n'), removed[0], added[0]);
    if (astResult.success) {
      return { success: true, updatedLines: astResult.code.split('\n') };
    }
  }

  return { success: false };
}

/**
 * Uses Babel AST traversal to pinpoint and rename member expressions (e.g. profile.userid -> profile.user_id).
 */
function tryAstMemberRename(code, removedLine, addedLine) {
  try {
    const oldPropMatch = removedLine.match(/([a-zA-Z0-9_$]+)\.([a-zA-Z0-9_$]+)/);
    const newPropMatch = addedLine.match(/([a-zA-Z0-9_$]+)\.([a-zA-Z0-9_$]+)/);

    if (!oldPropMatch || !newPropMatch) return { success: false };
    const objName = oldPropMatch[1];
    const oldProp = oldPropMatch[2];
    const newProp = newPropMatch[2];

    const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    let replaced = false;
    let newCode = code;

    traverse(ast, {
      MemberExpression(p) {
        if (
          !replaced &&
          p.node.object?.type === 'Identifier' &&
          p.node.object.name === objName &&
          p.node.property?.type === 'Identifier' &&
          p.node.property.name.toLowerCase() === oldProp.toLowerCase()
        ) {
          const start = p.node.property.start;
          const end = p.node.property.end;
          newCode = newCode.slice(0, start) + newProp + newCode.slice(end);
          replaced = true;
          p.stop();
        }
      },
    });

    return { success: replaced, code: newCode };
  } catch {
    return { success: false };
  }
}

/**
 * Semantic Fallback Patcher: Applies parsed diff directly to files on disk with atomic rollback.
 * Guarantees zero false positives: if no files are changed or any file fails, rolls back completely.
 */
export async function applySemanticFallback(diffString) {
  const filePatches = parseUnifiedDiff(diffString);
  if (filePatches.length === 0) {
    throw new Error('No valid file hunks could be parsed from the diff.');
  }

  const backups = new Map(); // filePath -> originalContent
  const createdFiles = new Set();
  const modifiedFiles = [];

  try {
    for (const patchObj of filePatches) {
      const targetRelPath = patchObj.newPath || patchObj.oldPath;
      const targetPath = resolveFilePath(targetRelPath);

      // 1. Handle new file creation
      if (patchObj.isNew) {
        const fullNewPath = targetPath || path.resolve(process.cwd(), targetRelPath);
        const dir = path.dirname(fullNewPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const newContent = patchObj.hunks.flatMap((h) => h.added).join('\n') + '\n';
        const syntaxCheck = validateSyntax(fullNewPath, newContent);
        if (!syntaxCheck.valid) {
          throw new Error(`Proposed new file '${targetRelPath}' has a syntax error: ${syntaxCheck.error}`);
        }

        fs.writeFileSync(fullNewPath, newContent, 'utf8');
        createdFiles.add(fullNewPath);
        modifiedFiles.push(targetRelPath);
        continue;
      }

      // 2. Handle file deletion
      if (patchObj.isDeleted) {
        if (fs.existsSync(targetPath)) {
          backups.set(targetPath, fs.readFileSync(targetPath, 'utf8'));
          fs.unlinkSync(targetPath);
          modifiedFiles.push(targetRelPath);
        }
        continue;
      }

      // 3. Handle file modification
      if (!targetPath || !fs.existsSync(targetPath)) {
        throw new Error(`Target file not found in repository: ${targetRelPath}`);
      }

      const originalContent = fs.readFileSync(targetPath, 'utf8');
      backups.set(targetPath, originalContent);

      const hasCrlf = originalContent.includes('\r\n');
      const normalizedOriginal = originalContent.replace(/\r\n/g, '\n');
      let currentLines = normalizedOriginal.split('\n');

      let anyHunkApplied = false;

      for (const hunk of patchObj.hunks) {
        const hunkRes = applyHunkToLines(currentLines, hunk, targetPath);
        if (hunkRes.success) {
          currentLines = hunkRes.updatedLines;
          anyHunkApplied = true;
        } else {
          // Check if already applied
          const alreadyContainsAdded = hunk.added.length > 0 && hunk.added.every((l) => normalizedOriginal.includes(l.trim()));
          if (alreadyContainsAdded) {
            continue;
          }
          throw new Error(
            `Patch hunk at line ${hunk.oldStart} could not be matched to any code in '${targetRelPath}'.`
          );
        }
      }

      let updatedContent = currentLines.join(hasCrlf ? '\r\n' : '\n');

      // Verify actual content modification
      if (updatedContent === originalContent) {
        // If content did not change, check if diff was already applied
        const alreadyApplied = patchObj.hunks.some((h) =>
          h.added.length > 0 && h.added.every((l) => originalContent.includes(l.trim()))
        );
        if (alreadyApplied) {
          continue; // File already has the fix
        }
        throw new Error(`Patch resulted in no changes to '${targetRelPath}'.`);
      }

      // Validate syntax before committing to disk
      const syntaxCheck = validateSyntax(targetPath, updatedContent);
      if (!syntaxCheck.valid) {
        throw new Error(`Proposed patch introduces a syntax error in '${targetRelPath}': ${syntaxCheck.error}`);
      }

      fs.writeFileSync(targetPath, updatedContent, 'utf8');
      modifiedFiles.push(targetRelPath);
    }

    if (modifiedFiles.length === 0) {
      throw new Error('Patch was already applied or resulted in no changes to working tree.');
    }

    return { success: true, method: 'semantic-fallback', modifiedFiles };
  } catch (err) {
    // Atomic Rollback: Restore all modified files from backups
    for (const [filePath, content] of backups.entries()) {
      try {
        fs.writeFileSync(filePath, content, 'utf8');
      } catch {}
    }
    // Remove any created files
    for (const createdPath of createdFiles) {
      try {
        if (fs.existsSync(createdPath)) fs.unlinkSync(createdPath);
      } catch {}
    }
    throw err;
  }
}

/**
 * Spawns git apply with given command-line flags.
 */
function runGitApply(diffContent, flags = []) {
  return new Promise((resolve) => {
    const git = spawn('git', ['apply', ...flags, '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    git.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    git.on('close', (code) => {
      resolve({
        success: code === 0,
        stderr: stderr.trim(),
      });
    });

    git.stdin.write(diffContent);
    git.stdin.end();
  });
}

/**
 * Main patch application entry point.
 * Tries progressive Git Apply strategies, then falls back to Semantic Fallback Patcher.
 * Guarantees syntax validation and atomic rollback on errors.
 */
export async function applyDiff(diffString) {
  if (!diffString || typeof diffString !== 'string' || !diffString.trim()) {
    throw new Error('No valid diff provided to apply.');
  }

  const normalized = normalizeDiff(diffString);

  // Snapshot target file mtimes to verify Git apply actually touched files
  const filePatches = parseUnifiedDiff(normalized);
  const targetPaths = filePatches
    .map((p) => resolveFilePath(p.newPath || p.oldPath))
    .filter(Boolean);

  const initialContents = new Map();
  for (const p of targetPaths) {
    if (fs.existsSync(p)) {
      initialContents.set(p, fs.readFileSync(p, 'utf8'));
    }
  }

  // Strategy 1: Git apply with whitespace and recount adjustments
  const strat1 = await runGitApply(normalized, ['-p1', '--recount', '--whitespace=fix', '-C1']);
  if (strat1.success && verifyAndValidateGitApply(targetPaths, initialContents)) {
    return { success: true, method: 'git-apply-recount' };
  }

  // Strategy 2: Git apply with relaxed whitespace
  const strat2 = await runGitApply(normalized, [
    '-p1',
    '--ignore-space-change',
    '--ignore-whitespace',
    '--recount',
    '-C1',
  ]);
  if (strat2.success && verifyAndValidateGitApply(targetPaths, initialContents)) {
    return { success: true, method: 'git-apply-ignore-whitespace' };
  }

  // Strategy 3: Git apply with zero context
  const strat3 = await runGitApply(normalized, [
    '-p1',
    '--unidiff-zero',
    '-C0',
    '--ignore-space-change',
    '--ignore-whitespace',
  ]);
  if (strat3.success && verifyAndValidateGitApply(targetPaths, initialContents)) {
    return { success: true, method: 'git-apply-unidiff-zero' };
  }

  // Strategy 4: Git apply with -p0
  const strat4 = await runGitApply(normalized, ['-p0', '--recount', '--whitespace=fix']);
  if (strat4.success && verifyAndValidateGitApply(targetPaths, initialContents)) {
    return { success: true, method: 'git-apply-p0' };
  }

  // Strategy 5: Git 3-way merge
  const strat5 = await runGitApply(normalized, ['-3', '--recount', '--whitespace=fix']);
  if (strat5.success && verifyAndValidateGitApply(targetPaths, initialContents)) {
    return { success: true, method: 'git-apply-3way' };
  }

  // Rollback any partial/broken git apply attempt before semantic fallback
  for (const [p, content] of initialContents.entries()) {
    try {
      if (fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
    } catch {}
  }

  // Strategy 6: Intelligent Semantic Fallback Patcher
  return await applySemanticFallback(normalized);
}

/**
 * Verifies that git apply actually modified the target files and did not produce syntax errors.
 */
function verifyAndValidateGitApply(targetPaths, initialContents) {
  let anyModified = false;

  for (const p of targetPaths) {
    if (!fs.existsSync(p)) continue;
    let curContent = fs.readFileSync(p, 'utf8');
    const initContent = initialContents.get(p);

    if (initContent !== undefined && curContent !== initContent) {
      // If original file had CRLF line endings, ensure CRLF is preserved consistently
      const origHadCrlf = initContent.includes('\r\n');
      if (origHadCrlf) {
        curContent = curContent.replace(/\r?\n/g, '\r\n');
        fs.writeFileSync(p, curContent, 'utf8');
      }

      anyModified = true;
      const syntax = validateSyntax(p, curContent);
      if (!syntax.valid) {
        return false; // Reject git apply if syntax error introduced
      }
    }
  }

  return anyModified;
}
