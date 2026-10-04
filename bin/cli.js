#!/usr/bin/env node

import { Command } from 'commander';
import pc from 'picocolors';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import 'dotenv/config';
import { getRecentChanges } from '../src/git.js';
import { triageRegression } from '../src/triage.js';
import { getRecentCursorPrompts } from '../src/cursor.js';
import { extractDiff, applyDiff } from '../src/patch.js';

const program = new Command();

program
  .name('triage-trip')
  .description('Autonomous triage for regressions introduced by AI edits')
  .version('0.1.0');

program
  .command('triage')
  .description('Diagnose why your build or code is failing')
  .argument('<query_or_error>', 'The error message or description of failure')
  .option('-c, --commits <number>', 'Number of recent commits to analyze', '5')
  .option('-y, --yes', 'Automatically apply the patch without asking', false)
  .action(async (errorInput, options) => {
    console.log(pc.bold(pc.cyan('\n■ Triage-Trip Engine\n')));

    const spinner = ora('Reading recent git changes & Cursor prompts...').start();
    let diagnosis = '';
    
    try {
      const commitCount = parseInt(options.commits, 10);
      const [changes, prompts] = await Promise.all([
        getRecentChanges(commitCount),
        Promise.resolve().then(() => getRecentCursorPrompts(10))
      ]);

      spinner.text = 'Isolating structural contract shifts and AST regressions...';
      diagnosis = await triageRegression(errorInput, changes, prompts);

      spinner.succeed(pc.green('Root cause isolated.'));
      console.log('\n' + diagnosis + '\n');
    } catch (err) {
      spinner.fail(pc.red('Triage failed: ' + err.message));
      process.exit(1);
    }

    // Attempt to extract patch from LLM output
    const patch = extractDiff(diagnosis);

    if (patch) {
      let shouldApply = options.yes;

      if (!shouldApply) {
        shouldApply = await confirm({
          message: 'Apply this patch to your working tree now?',
          default: true,
        });
      }

      if (shouldApply) {
        const patchSpinner = ora('Applying patch via git apply...').start();
        try {
          await applyDiff(patch);
          patchSpinner.succeed(pc.green('Patch applied successfully to working tree.'));
          console.log(pc.dim('Run `git diff` to review or `git commit` to save the fix.\n'));
        } catch (err) {
          patchSpinner.fail(pc.red(err.message));
        }
      }
    }
  });

program.parse(process.argv);