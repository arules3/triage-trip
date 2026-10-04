import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export function extractDiff(llmOutput) {
  const diffMatch =
    llmOutput.match(/```diff\s*([\s\S]*?)```/) ||
    llmOutput.match(/(--- [^\n]+\n\+\+\+ [^\n]+[\s\S]*)/);
  if (!diffMatch) return null;

  let rawDiff = diffMatch[1] || diffMatch[0];
  rawDiff = rawDiff.replace(/\u00A0/g, ' ');
  if (!rawDiff.endsWith('\n')) rawDiff += '\n';
  return rawDiff.trim() + '\n';
}

export async function applyDiff(diffString) {
  // Strategy 1: Git apply with whitespace and recount adjustments
  const gitRes = await runGitApply(diffString, ['--recount', '--whitespace=fix', '-C1']);
  if (gitRes.success) return true;

  // Strategy 2: Git 3-way merge
  const threeWayRes = await runGitApply(diffString, ['-3', '--recount', '--whitespace=fix']);
  if (threeWayRes.success) return true;

  // Strategy 3: Targeted line-replacement fallback
  const fallbackApplied = applyLineFallback(diffString);
  if (fallbackApplied) return true;

  throw new Error(`Patch cannot apply cleanly:\n${gitRes.stderr || threeWayRes.stderr}`);
}

function runGitApply(diffContent, flags = []) {
  return new Promise((resolve) => {
    const git = spawn('git', ['apply', ...flags, '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    git.stderr.on('data', (d) => { stderr += d.toString(); });
    git.on('close', (code) => resolve({ success: code === 0, stderr: stderr.trim() }));

    git.stdin.write(diffContent);
    git.stdin.end();
  });
}

function applyLineFallback(diffString) {
  try {
    const fileMatch = diffString.match(/\+\+\+ b\/(.+)/);
    if (!fileMatch) return false;

    const filePath = path.resolve(process.cwd(), fileMatch[1].trim());
    if (!fs.existsSync(filePath)) return false;

    const lines = diffString.split('\n');
    const removed = lines
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))
      .map((l) => l.slice(1).trim());
    const added = lines
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1).trim());

    if (removed.length === 0 || added.length === 0) return false;

    let content = fs.readFileSync(filePath, 'utf8');

    // Single-line or exact block match replacement
    for (let i = 0; i < removed.length; i++) {
      if (removed[i] && added[i] && content.includes(removed[i])) {
        content = content.replace(removed[i], added[i]);
      }
    }

    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}