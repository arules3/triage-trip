# ai-blackbox Architecture Rules

You are helping build `ai-blackbox`, a high-speed CLI tool designed to pinpoint regressions introduced by AI code assistants.

Guidelines:
- Modern Node.js (ESM only, Node 18+).
- Keep dependencies light; terminal performance and zero startup latency are top priorities.
- Use `simple-git` for Git diff extraction.
- Use `@babel/parser` and `@babel/traverse` for AST inspection (JS/TS/JSX).
- Output must be formatted for the terminal using `picocolors`.
- Avoid background daemons for now; prioritize an instantaneous `npx ai-blackbox triage <query>` command.