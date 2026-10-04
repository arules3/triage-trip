// src/triage.js
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export async function triageRegression(errorDescription, gitContext, cursorPrompts = []) {
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
- Do not invent comments in context lines.
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

CRITICAL RULES FOR THE PATCH:
- Never delete the entire file. The patch must FIX the bug in the existing file.
- Format strictly as a valid unified diff block in \`\`\`diff.
- Target the file accurately:
  --- a/<path>
  +++ b/<path>
- Only change the breaking line(s). Keep 1-2 lines of unchanged surrounding context lines above and below without '+' or '-'.
- Example format:
\`\`\`diff
--- a/app.js
+++ b/app.js
@@ -6,3 +6,3 @@
-  console.log(\`Loading dashboard for user ID: \${profile.userId.toUpperCase()}\`);
+  console.log(\`Loading dashboard for user ID: \${profile.user_id.toUpperCase()}\`);
\`\`\`
`;

  // 1. Prefer Anthropic if key exists
  if (anthropicKey) {
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1500,
      system: systemInstructions,
      messages: [{ role: 'user', content: userPrompt }]
    });
    return response.content[0].text;
  }

  // 2. Fallback to OpenAI
  const openai = new OpenAI({ apiKey: openaiKey });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemInstructions },
      { role: 'user', content: userPrompt }
    ]
  });
  return response.choices[0].message.content;
}