# `ai-blackbox`

> Autonomous AI Regression Triage & Provenance CLI. Pinpoint breaking contract changes introduced by AI coding tools in seconds.

---

## The Problem

AI coding assistants (Cursor, GitHub Copilot, Windsurf) dramatically accelerate drafting and refactoring code. However, they frequently cause **silent contract drift**:

* An AI renames an object key or subtle schema attribute (e.g., `userId` ➔ `user_id`).
* Standard linters and compilers pass because the syntax is completely valid.
* Downstream modules crash 2–3 commits later with cryptic runtime errors (`TypeError: Cannot read properties of undefined`).
* Developers spend 20–30 minutes manually inspecting multi-file diffs, running `git bisect`, and searching for what changed.

---

## What `ai-blackbox` Does

`ai-blackbox` connects the dots across your development environment to trace the exact lineage of a regression:

```text
[ User Prompt in IDE ] ➔ [ AI Generated Diff ] ➔ [ Git Commit ] ➔ [ Runtime Error ]
                                                                          │
                                                                   ai-blackbox triage
                                                                          │
                                                                          ▼
                                                       • Exact Root Cause & Commit
                                                       • Attributed AI Prompt
                                                       • Semantic Contract Shift
                                                       • Clean Unified Diff Patch

```

1. **Inspects Git History:** Automatically reads uncommitted working changes and recent commits using `simple-git`.
2. **Extracts AI Session Provenance:** Scans local IDE storage (e.g., Cursor's local SQLite database `state.vscdb`) to retrieve recent prompts and user instructions.
3. **Triages Semantic Drift:** Correlates the runtime stack trace with recent AST modifications and prompts via the OpenAI API to deliver an instant diagnostic report.

---

## Installation

### Prerequisites

* **Node.js** (v18 or higher, ESM native)
* An active **OpenAI API Key**

### Local Setup

```bash
# Clone the repository
git clone https://github.com/your-username/ai-blackbox.git
cd ai-blackbox

# Install dependencies
npm install

# Link executable globally (optional for direct CLI access)
npm link

```

Set your OpenAI API key in your terminal environment or add it to a `.env` file:

```bash
export OPENAI_API_KEY="sk-..."

```

---

## Quickstart & Usage

Run the triage engine directly against any runtime error message or stack trace:

```bash
# Via npm script
node bin/cli.js triage "TypeError: Cannot read properties of undefined (reading 'toUpperCase')"

# Or globally (if linked)
ai-blackbox triage "TypeError: Cannot read properties of undefined (reading 'toUpperCase')"

```

### Options

* `<query_or_error>` *(required)*: The error message or failing test description.
* `-c, --commits <number>`: Number of recent commits to analyze (default: `5`).

---

## Example Output

```markdown
■ AI-Blackbox Triage Engine

✔ Root cause isolated.

1. **Root Cause**: The error occurs in `app.js` at line 6, where `profile.userId` is accessed. 
   The breaking change was introduced in commit `b83c577` ("refactor: update user schema"), 
   which modified the `getUserProfile` function in `user.js`.

2. **Attributed Prompt**: "Rename userId to user_id across the returned profile object."

3. **The Shift**: The `getUserProfile` function now returns `user_id` instead of `userId`, 
   causing `profile.userId` to evaluate to `undefined`.

4. **Patch**:
--- a/app.js
+++ b/app.js
@@ -6,2 +6,2 @@
-  console.log(`Loading dashboard for user ID: ${profile.userId.toUpperCase()}`);
+  console.log(`Loading dashboard for user ID: ${profile.user_id.toUpperCase()}`);

```

---

## Project Structure

```text
ai-blackbox/
├── bin/
│   └── cli.js            # CLI commands & terminal output formatting (Commander, Ora, Picocolors)
├── src/
│   ├── git.js            # Working tree and commit diff extraction (simple-git)
│   ├── cursor.js         # Cursor SQLite database parser (better-sqlite3)
│   └── triage.js         # OpenAI triage diagnostic engine (GPT-4o)
├── package.json
└── README.md

```

---

## Roadmap

* [x] Git diff & commit stream extraction
* [x] Local SQLite prompt extraction for Cursor Composer
* [x] OpenAI regression diagnostic engine
* [ ] Auto-patch application flag (`--fix` via `git apply`)
* [ ] Multi-IDE adapters (GitHub Copilot Chat, Windsurf Cascade, Claude Code)
* [ ] GitHub Action runner for automated PR failure triage
