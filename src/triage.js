// src/triage.js
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { cleanGitContext } from './utils.js';

export async function triageRegression(errorDescription, gitContext, editorPrompts = [], onStreamStart) {
  if (!errorDescription || typeof errorDescription !== 'string' || !errorDescription.trim()) {
    throw new Error('Query or error trace cannot be empty.');
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey && !openaiKey) {
    throw new Error('Please set either ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment.');
  }

  const systemInstructions = `
You are an expert developer tool agent specializing in Git diff analysis, AST regression diagnosis, and code patch generation.

When analyzing the regression:
- Focus on contract/schema shifts between callers and callees (e.g. key renames in returned objects, changed parameter signatures).
- Prefer aligning property access to match the actual returned schema (e.g. renaming \`profile.userId\` to \`profile.user_id\`) rather than applying defensive null checks or fallbacks like ternary operators or 'UNKNOWN', unless explicitly intended.

When generating the "Patch" section:
- Always use a valid, standard unified diff format enclosed in \`\`\`diff.
- Include proper headers (--- a/path/to/file.js, +++ b/path/to/file.js).
- Ensure @@ -line,count +line,count @@ markers accurately match the context.
- Include 1-2 lines of unchanged surrounding context above and below the change.
- Only touch lines that actually exist in the file.
- The '-' (removed) lines MUST match the EXACT text, indentation, and casing from the active working file on disk.
`.trim();

  const safeGitContext = cleanGitContext(gitContext);

  const activeFilesSection = safeGitContext.activeFileContents && Object.keys(safeGitContext.activeFileContents).length > 0
    ? `Active Working Files on Disk (Current File Contents & Line Numbers):\n${JSON.stringify(safeGitContext.activeFileContents, null, 2)}`
    : '';

  const hasPrompts = Array.isArray(editorPrompts) && editorPrompts.length > 0;
  const promptsSection = hasPrompts
    ? `Recent IDE / Editor Prompts:\n${JSON.stringify(editorPrompts, null, 2)}`
    : 'No local IDE prompt telemetry available. Attribute cause using Git commit messages and diffs.';

  const attributedStepLabel = hasPrompts ? 'Attributed Prompt' : 'Attributed Intent';
  const attributedStepDetail = hasPrompts
    ? 'Name the specific IDE/editor prompt that likely caused this diff (if found in the list; otherwise state none).'
    : 'Infer the likely author intent from Git commit messages and diffs (no IDE prompt telemetry available).';

  const userPrompt = `
User problem / error trace:
"${errorDescription}"

${activeFilesSection}

${promptsSection}

Recent Repository Git Stream (Working diff + Commits):
${JSON.stringify({
  branch: safeGitContext.branch,
  untrackedFiles: safeGitContext.untrackedFiles,
  workingDiff: safeGitContext.workingDiff,
  recentCommits: safeGitContext.recentCommits,
}, null, 2)}

Provide a strict, concise triage output formatted with terminal-friendly Markdown:
1. **Root Cause**: Pinpoint the file, line, and commit/working diff where the breaking change occurred.
2. **${attributedStepLabel}**: ${attributedStepDetail}
3. **The Shift**: Explain what broke (e.g., schema key rename, dropped parameter, async/await omission).
4. **Patch**: Provide the exact unified diff adhering strictly to the system diff formatting instructions.

CRITICAL RULES FOR THE PATCH:
- The '-' (removed) lines MUST match the EXACT text, indentation, and casing currently in the file shown in "Active Working Files on Disk".
- Target the file accurately:
  --- a/<path>
  +++ b/<path>
- Never delete the entire file. The patch must FIX the bug in the existing file.
- Format strictly as a valid unified diff block in \`\`\`diff.
- Only change the breaking line(s). Keep 1-2 lines of unchanged surrounding context lines above and below without '+' or '-'.
- Example format:
\`\`\`diff
--- a/src/app.js
+++ b/src/app.js
@@ -5,3 +5,3 @@
   const profile = getUserProfile();
-  console.log(\`Loading dashboard for user ID: \${profile.userid.toUpperCase()}\`);
+  console.log(\`Loading dashboard for user ID: \${profile.user_id.toUpperCase()}\`);
   return profile;
\`\`\`
`;

  let streamStarted = false;
  const emitChunk = (text) => {
    if (!text) return;
    if (!streamStarted) {
      streamStarted = true;
      if (typeof onStreamStart === 'function') onStreamStart();
    }
    process.stdout.write(text);
  };

  // 1. Prefer Anthropic if key exists
  if (anthropicKey) {
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const stream = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
      max_tokens: 1500,
      system: systemInstructions,
      messages: [{ role: 'user', content: userPrompt }],
      stream: true,
    });

    let fullText = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const chunk = event.delta.text || '';
        emitChunk(chunk);
        fullText += chunk;
      }
    }
    return fullText;
  }

  // 2. Fallback to OpenAI
  const openai = new OpenAI({ apiKey: openaiKey });
  const stream = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0.1,
    stream: true,
    messages: [
      { role: 'system', content: systemInstructions },
      { role: 'user', content: userPrompt }
    ]
  });

  let fullText = '';
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    emitChunk(text);
    fullText += text;
  }
  return fullText;
}
