import OpenAI from 'openai';

/**
 * Triages an error trace against recent Git diffs and Cursor Composer prompts.
 *
 * @param {string} errorDescription - The runtime error message or stack trace.
 * @param {object} gitContext - Object containing recentCommits and workingDiff from git.js.
 * @param {Array} [cursorPrompts=[]] - Array of prompt objects retrieved from cursor.js.
 * @returns {Promise<string>} Terminal-friendly markdown triage report.
 */
export async function triageRegression(errorDescription, gitContext, cursorPrompts = []) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is missing.');
  }

  const openai = new OpenAI({ apiKey });

  const systemInstructions = `
You are an expert developer tool agent specializing in Git diff analysis, AST regression diagnosis, and code patch generation.

When generating the "Patch" section:
- Always use a valid, standard unified diff format enclosed in \`\`\`diff.
- Include proper headers (--- a/path/to/file.js, +++ b/path/to/file.js).
- Ensure @@ -line,count +line,count @@ markers accurately match the context.
- Include 1-2 lines of unchanged surrounding context above and below the change.
- Never add commentary or markdown inside the \`\`\`diff block itself.
`.trim();

  const userPrompt = `
User problem / error trace:
"${errorDescription}"

Recent Cursor Composer Prompts:
${JSON.stringify(cursorPrompts, null, 2)}

Recent Repository Git Stream (Working diff + Commits):
${JSON.stringify(gitContext, null, 2)}

Provide a strict, concise triage output formatted with terminal-friendly Markdown:
1. **Root Cause**: Pinpoint the file, line, and commit/working diff where the breaking change occurred.
2. **Attributed Prompt**: Name the specific Cursor prompt that likely caused this diff (if found in the list; otherwise state none).
3. **The Shift**: Explain what broke (e.g., schema key rename, dropped parameter, async/await omission).
4. **Patch**: Provide the exact unified diff adhering strictly to the system diff formatting instructions.

Instructions for the Patch section:
- Only touch lines that actually exist in the file.
- Do not invent comments (e.g. "// This line expects...") in context lines.
- Only output the exact lines being changed with standard 1-line prefix context.
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1, // Lower temperature produces more deterministic diff offsets
    messages: [
      {
        role: 'system',
        content: systemInstructions
      },
      {
        role: 'user',
        content: userPrompt
      }
    ]
  });

  return response.choices[0].message.content;
}