#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import 'dotenv/config';
import { getRecentChanges } from '../src/git.js';
import { getRecentCursorPrompts } from '../src/cursor.js'; // <-- 1. Import cursor helper
import { triageRegression } from '../src/triage.js';

const program = new Command();

program
  .name('ai-blackbox')
  .description('Autonomous triage for regressions introduced by AI edits')
  .version('0.1.0');

program
  .command('triage')
  .description('Diagnose why your build or code is failing')
  .argument('<query_or_error>', 'The error message or description of failure')
  .option('-c, --commits <number>', 'Number of recent commits to analyze', '5')
  .action(async (errorInput, options) => {
    console.log(pc.bold(pc.cyan('\n■ AI-Blackbox Triage Engine\n')));
    const spinner = ora('Reading recent git stream & cursor prompts...').start();

    try {
      const commitCount = parseInt(options.commits, 10);
      
      // Fetch both Git diffs and local Cursor prompts
      const changes = await getRecentChanges(commitCount);
      const prompts = getRecentCursorPrompts(5); // <-- 2. Read SQLite prompts

      spinner.text = 'Isolating structural contract shifts and prompt attribution...';
      
      // Pass prompts as 3rd parameter
      const diagnosis = await triageRegression(errorInput, changes, prompts); // <-- 3. Pass prompts here

      spinner.succeed(pc.green('Root cause isolated.'));
      console.log('\n' + diagnosis + '\n');
    } catch (err) {
      spinner.fail(pc.red('Triage failed: ' + err.message));
      process.exit(1);
    }
  });

program.parse(process.argv);