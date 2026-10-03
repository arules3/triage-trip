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

  const prompt = `
You are an autonomous AST and git triage agent.
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
4. **Patch**: Provide the exact unified diff or fix.
Keep it strictly technical and concise.
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'You are an expert developer tool agent specializing in Git diff analysis and AST regression diagnosis.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  return response.choices[0].message.content;
}