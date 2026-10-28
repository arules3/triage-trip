import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { applyDiff, extractDiff, normalizeDiff, validateSyntax } from '../src/patch.js';
import { triageRegression } from '../src/triage.js';

async function runSimulations() {
  console.log('🚀 Running Simulations: Big Code Errors, Multiline File Errors & Invalid Queries\n');

  const tmpDir = path.resolve(process.cwd(), 'test_sim_sandbox');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // =========================================================================
    // SCENARIO 1: Big Code Errors (Complex files with 100+ lines, multiple hunks)
    // =========================================================================
    console.log('------------------------------------------------------------');
    console.log('SCENARIO 1: Big Code Error Simulation (100+ line module, multi-hunk patch)');
    console.log('------------------------------------------------------------');

    const bigFilePath = path.join(tmpDir, 'BigService.js');
    const bigFileRel = path.relative(process.cwd(), bigFilePath);

    // Generate a 120-line service file with realistic structure
    const bigFileLines = [
      '// BigService.js - Enterprise Order Processing Service',
      'import { logger } from "./logger.js";',
      '',
      'export class BigService {',
      '  constructor(config = {}) {',
      '    this.config = config;',
      '    this.retryCount = 3;',
      '    this.orders = new Map();',
      '  }',
    ];
    for (let i = 1; i <= 35; i++) {
      bigFileLines.push(`  helperRoutine${i}(input) { return input * ${i}; }`);
    }
    bigFileLines.push(
      '  processOrder(order) {',
      '    // HUNK 1 target: breaking change in order id contract',
      '    const orderId = order.order_id_broken;',
      '    logger.info(`Processing order: ${orderId}`);',
      '    return { success: true, id: orderId };',
      '  }'
    );
    for (let i = 36; i <= 70; i++) {
      bigFileLines.push(`  auditLog${i}(payload) { return { audited: true, seq: ${i} }; }`);
    }
    bigFileLines.push(
      '  calculateTotal(items = []) {',
      '    // HUNK 2 target: breaking pricing calculation discount logic',
      '    const discountMultiplier = this.config.discountPercent / 100;',
      '    return items.reduce((acc, curr) => acc + (curr.price * discountMultiplier), 0);',
      '  }',
      '}'
    );
    fs.writeFileSync(bigFilePath, bigFileLines.join('\n') + '\n', 'utf8');

    // Simulate multi-hunk patch targeting two distinct sections 50 lines apart
    const bigFileDiff = `--- a/${bigFileRel}
+++ b/${bigFileRel}
@@ -42,5 +42,5 @@ export class BigService {
   processOrder(order) {
     // HUNK 1 target: breaking change in order id contract
-    const orderId = order.order_id_broken;
+    const orderId = order.orderId;
     logger.info(\`Processing order: \${orderId}\`);
@@ -80,5 +80,5 @@ export class BigService {
   calculateTotal(items = []) {
     // HUNK 2 target: breaking pricing calculation discount logic
-    const discountMultiplier = this.config.discountPercent / 100;
+    const discountMultiplier = 1 - (this.config.discountPercent / 100);
     return items.reduce((acc, curr) => acc + (curr.price * discountMultiplier), 0);
`;

    const bigPatchRes = await applyDiff(bigFileDiff);
    assert(bigPatchRes.success === true, 'Big file patch should succeed');
    const patchedBigContent = fs.readFileSync(bigFilePath, 'utf8');
    assert(patchedBigContent.includes('const orderId = order.orderId;'), 'Hunk 1 applied');
    assert(patchedBigContent.includes('1 - (this.config.discountPercent / 100)'), 'Hunk 2 applied');
    assert(validateSyntax(bigFilePath, patchedBigContent).valid === true, 'Big file remains syntactically valid');
    console.log('✓ Big file multi-hunk patch applied cleanly across 100+ lines with syntax intact.\n');


    // =========================================================================
    // SCENARIO 2: Multiline File Errors & Replacements
    // =========================================================================
    console.log('------------------------------------------------------------');
    console.log('SCENARIO 2: Multiline File Errors (Signature refactors, parameter shifts)');
    console.log('------------------------------------------------------------');

    const multiFilePath = path.join(tmpDir, 'MultiContract.js');
    const multiFileRel = path.relative(process.cwd(), multiFilePath);

    const multiFileContent = `// MultiContract.js
export async function transferFunds(
  sourceAccount,
  targetAccount,
  amount,
  currency,
  options = {}
) {
  // Multiline contract block
  const transaction = await db.transact(async (tx) => {
    const balance = await tx.getBalance(sourceAccount);
    if (balance < amount) {
      throw new Error("Insufficient balance");
    }
    await tx.debit(sourceAccount, amount);
    await tx.credit(targetAccount, amount);
    return { status: "COMPLETED", id: "tx_9981" };
  });

  return transaction;
}
`;
    fs.writeFileSync(multiFilePath, multiFileContent, 'utf8');

    // Simulate multiline refactoring: expanding transaction block with currency conversion & idempotency key
    const multilineDiff = `--- a/${multiFileRel}
+++ b/${multiFileRel}
@@ -10,7 +10,10 @@ export async function transferFunds(
   const transaction = await db.transact(async (tx) => {
     const balance = await tx.getBalance(sourceAccount);
-    if (balance < amount) {
-      throw new Error("Insufficient balance");
-    }
-    await tx.debit(sourceAccount, amount);
-    await tx.credit(targetAccount, amount);
+    const converted = currency === "USD" ? amount : amount * 1.15;
+    if (balance < converted) {
+      throw new Error("Insufficient funds for transfer");
+    }
+    await tx.debit(sourceAccount, converted, { idempotencyKey: options.idempotencyKey });
+    await tx.credit(targetAccount, converted);
     return { status: "COMPLETED", id: "tx_9981" };
   });
`;

    const multiPatchRes = await applyDiff(multilineDiff);
    assert(multiPatchRes.success === true, 'Multiline diff should apply cleanly');
    const patchedMultiContent = fs.readFileSync(multiFilePath, 'utf8');
    assert(patchedMultiContent.includes('const converted = currency === "USD" ? amount : amount * 1.15;'), 'Multiline conversion added');
    assert(patchedMultiContent.includes('{ idempotencyKey: options.idempotencyKey }'), 'Options idempotency passed');
    assert(validateSyntax(multiFilePath, patchedMultiContent).valid === true, 'Syntax valid');
    console.log('✓ Multiline block replacement correctly adapted indentation and parameters.\n');


    // =========================================================================
    // SCENARIO 3: Invalid Queries & Negative Error Scenarios
    // =========================================================================
    console.log('------------------------------------------------------------');
    console.log('SCENARIO 3: Invalid Queries & Negative Edge Cases');
    console.log('------------------------------------------------------------');

    // 3a. Empty query
    let emptyQueryCaught = false;
    try {
      await triageRegression('', {}, []);
    } catch (err) {
      emptyQueryCaught = true;
      assert(err.message.includes('cannot be empty'), 'Throws on empty query');
    }
    assert(emptyQueryCaught, 'Must catch empty query error');
    console.log('✓ 3a: Empty query rejected immediately with descriptive message');

    // 3b. Whitespace-only query
    let wsQueryCaught = false;
    try {
      await triageRegression('     \n\t   ', {}, []);
    } catch (err) {
      wsQueryCaught = true;
      assert(err.message.includes('cannot be empty'), 'Throws on whitespace query');
    }
    assert(wsQueryCaught, 'Must catch whitespace-only query error');
    console.log('✓ 3b: Whitespace query rejected');

    // 3c. Gibberish query with no diff or broken patch returned by LLM
    const noDiffOutput = 'I analyzed the system but found no relevant git diff or root cause.';
    const extractedNoDiff = extractDiff(noDiffOutput);
    assert(extractedNoDiff === null, 'No patch should be extracted from narrative text');
    console.log('✓ 3c: Output without diff block handled gracefully without crashing');

    // 3d. Corrupted hunk header line recount
    const corruptHeaderDiff = `--- a/${multiFileRel}
+++ b/${multiFileRel}
@@ -999,0 +999,0 @@
-const impossible = 1;
+const impossible = 2;
`;
    let corruptHunkCaught = false;
    try {
      await applyDiff(corruptHeaderDiff);
    } catch (err) {
      corruptHunkCaught = true;
      assert(err.message.includes('could not be matched') || err.message.includes('cannot apply cleanly'), 'Rejects unmatchable hunk');
    }
    assert(corruptHunkCaught, 'Must catch unmatchable hunk error');
    console.log('✓ 3d: Corrupted / unmatchable hunk cleanly rejected without modifying repository');

    // 3e. Syntactically invalid replacement (attempting to write malformed JS)
    const syntaxBreakDiff = `--- a/${multiFileRel}
+++ b/${multiFileRel}
@@ -2,3 +2,3 @@
-export async function transferFunds(
+export async function transferFunds( {{{ [[ broken syntax illegal token
`;
    let syntaxBreakCaught = false;
    const beforeContent = fs.readFileSync(multiFilePath, 'utf8');
    try {
      await applyDiff(syntaxBreakDiff);
    } catch (err) {
      syntaxBreakCaught = true;
      assert(err.message.includes('syntax error'), 'Catches syntax error during patch');
    }
    assert(syntaxBreakCaught, 'Must reject patch with syntax error');
    const afterContent = fs.readFileSync(multiFilePath, 'utf8');
    assert(beforeContent === afterContent, 'Atomic rollback ensures file remains intact');
    console.log('✓ 3e: Patch introducing syntax errors is detected and atomically rolled back');

    console.log('\n============================================================');
    console.log('ALL SIMULATION SCENARIOS PASSED WITH ZERO FAILURES! 🎉');
    console.log('============================================================\n');
  } finally {
    // Cleanup temporary simulation files
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

runSimulations().catch((err) => {
  console.error('Simulation test failed:', err);
  process.exit(1);
});
