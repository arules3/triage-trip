// src/patch.js
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export function extractDiff(llmOutput) {
  const diffMatch =
    llmOutput.match(/```diff\s*([\s\S]*?)```/) ||
    llmOutput.match(/(--- [^\n]+\n\+\+\+ [^\n]+[\s\S]*)/);

  if (!diffMatch) return null;
  let rawDiff = diffMatch[1] || diffMatch[0];

  rawDiff = rawDiff.replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');
  rawDiff = rawDiff.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$\n?/m, '');

  if (!rawDiff.endsWith('\n')) {
    rawDiff += '\n';
  }

  return rawDiff.trim() + '\n';
}

export async function applyDiff(diffString) {
  const flags = [
    '--recount',
    '--ignore-space-change',
    '--ignore-whitespace',
    '--whitespace=nowarn',
    '-C1'
  ];

  // 1. Try git apply
  const attempt = await runGitApply(diffString, flags);
  if (attempt.success) return true;

  // 2. Try git apply with 3way
  const attempt3Way = await runGitApply(diffString, [...flags, '--3way']);
  if (attempt3Way.success) return true;

  // 3. Fallback: Direct line search & replace on disk
  const applied = fallbackManualPatch(diffString);
  if (applied) return true;

  throw new Error(`Patch cannot apply cleanly:\n${attempt.stderr}`);
}

function runGitApply(diffContent, flags = []) {
  return new Promise((resolve) => {
    const git = spawn('git', ['apply', ...flags, '-'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    git.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    git.on('close', (code) => {
      resolve({
        success: code === 0,
        stderr: stderr.trim()
      });
    });

    git.stdin.write(diffContent);
    git.stdin.end();
  });
}

function fallbackManualPatch(diffString) {
  try {
    const fileMatch = diffString.match(/\+\+\+ b\/(.+)/);
    if (!fileMatch) return false;

    const relativePath = fileMatch[1].trim();
    const filePath = path.resolve(process.cwd(), relativePath);
    if (!fs.existsSync(filePath)) return false;

    const fileContent = fs.readFileSync(filePath, 'utf8');

    // Extract removed (-) and added (+) lines from the hunk
    const lines = diffString.split('\n');
    let oldLine = null;
    let newLine = null;

    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        oldLine = line.slice(1).trim();
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLine = line.slice(1).trim();
      }
    }

    if (!oldLine || !newLine) return false;

    // Scan file lines and replace the matching content while preserving original indentation
    const fileLines = fileContent.split('\n');
    let replaced = false;

    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i].includes(oldLine)) {
        const indentMatch = fileLines[i].match(/^\s*/);
        const indent = indentMatch ? indentMatch[0] : '';
        fileLines[i] = indent + newLine;
        replaced = true;
        break;
      }
    }

    if (replaced) {
      fs.writeFileSync(filePath, fileLines.join('\n'), 'utf8');
      return true;
    }

    return false;
  } catch {
    return false;
  }
}