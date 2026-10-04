import fs from 'fs';
import assert from 'assert';
import { applyDiff, extractDiff, normalizeDiff, validateSyntax } from '../src/patch.js';

async function runAllTests() {
  console.log('Running test suite for triage-trip patch engine...\n');

  // Test 1: extractDiff
  console.log('Test 1: extractDiff formats');
  const d1 = extractDiff('Some text\n```diff\n--- a/file.js\n+++ b/file.js\n@@ -1,1 +1,1 @@\n-old\n+new\n```\nMore text');
  assert(d1 && d1.includes('--- a/file.js'));
  const d2 = extractDiff('Raw diff:\n--- a/file.js\n+++ b/file.js\n@@ -1,1 +1,1 @@\n-old\n+new\n');
  assert(d2 && d2.includes('+++ b/file.js'));
  const d3 = extractDiff('No diff here at all');
  assert(d3 === null);
  console.log('✓ extractDiff passed');

  // Test 2: normalizeDiff hunk recount
  console.log('Test 2: normalizeDiff hunk recount');
  const malformedHunk = '--- file.js\n+++ file.js\n@@ -1,99 +1,99 @@\n context\n-removed\n+added\n context';
  const norm = normalizeDiff(malformedHunk);
  assert(norm.includes('--- a/file.js'));
  assert(norm.includes('+++ b/file.js'));
  assert(norm.includes('@@ -1,3 +1,3 @@'));
  console.log('✓ normalizeDiff passed');

  // Test 3: validateSyntax
  console.log('Test 3: validateSyntax');
  assert(validateSyntax('test.js', 'const x = 1;').valid === true);
  assert(validateSyntax('test.js', 'const x = ;').valid === false);
  assert(validateSyntax('test.tsx', 'const el = <div className="test">1</div>;').valid === true);
  assert(validateSyntax('test.json', '{"a": 1}').valid === true);
  assert(validateSyntax('test.json', '{"a": }').valid === false);
  console.log('✓ validateSyntax passed');

  // Test 4: Real terminal case - identifier casing difference (userID vs userid)
  console.log('Test 4: Real terminal bug - case-tolerant identifier patch');
  const tempFile = 'test_app.js';
  fs.writeFileSync(tempFile, 'function test() {\n  const profile = getUser();\n  console.log(profile.userid.toUpperCase());\n}\n');
  const caseDiff = `--- a/${tempFile}
+++ b/${tempFile}
@@ -1,4 +1,4 @@
 function test() {
   const profile = getUser();
-  console.log(profile.userID.toUpperCase());
+  console.log(profile.user_id.toUpperCase());
 }
`;
  const resCase = await applyDiff(caseDiff);
  assert(resCase.success === true);
  const updatedContent = fs.readFileSync(tempFile, 'utf8');
  assert(updatedContent.includes('profile.user_id.toUpperCase()'));
  assert(!updatedContent.includes('profile.userid'));
  fs.unlinkSync(tempFile);
  console.log('✓ Real terminal case passed');

  // Test 5: Multi-line hunk replacement preserving indentation
  console.log('Test 5: Multi-line hunk replacement with indentation');
  fs.writeFileSync(tempFile, '    // start\n    const a = 1;\n    const b = 2;\n    // end\n');
  const multilineDiff = `--- a/${tempFile}
+++ b/${tempFile}
@@ -2,2 +2,3 @@
-    const a = 1;
-    const b = 2;
+    const a = 10;
+    const b = 20;
+    const c = 30;
`;
  await applyDiff(multilineDiff);
  const mlContent = fs.readFileSync(tempFile, 'utf8');
  assert(mlContent.includes('    const a = 10;'));
  assert(mlContent.includes('    const b = 20;'));
  assert(mlContent.includes('    const c = 30;'));
  fs.unlinkSync(tempFile);
  console.log('✓ Multi-line replacement passed');

  // Test 6: Negative - Non-existent file
  console.log('Test 6: Negative - Target file not found');
  let threw = false;
  try {
    await applyDiff('--- a/non_existent.js\n+++ b/non_existent.js\n@@ -1,1 +1,1 @@\n-a\n+b\n');
  } catch (err) {
    threw = true;
    assert(err.message.includes('Target file not found'));
  }
  assert(threw);
  console.log('✓ Non-existent file rejection passed');

  // Test 7: Negative - Unmatchable hunk
  console.log('Test 7: Negative - Unmatchable hunk');
  fs.writeFileSync(tempFile, 'const valid = true;\n');
  threw = false;
  try {
    await applyDiff(`--- a/${tempFile}
+++ b/${tempFile}
@@ -10,1 +10,1 @@
-some alien content that never exists anywhere in the universe
+new content`);
  } catch (err) {
    threw = true;
    assert(err.message.includes('could not be matched'));
  }
  assert(threw);
  const stillValid = fs.readFileSync(tempFile, 'utf8');
  assert(stillValid === 'const valid = true;\n');
  fs.unlinkSync(tempFile);
  console.log('✓ Unmatchable hunk rejection & file preservation passed');

  // Test 8: Negative - Syntax error rollback
  console.log('Test 8: Negative - Syntax error rollback');
  fs.writeFileSync(tempFile, 'function foo() { return 42; }\n');
  threw = false;
  try {
    await applyDiff(`--- a/${tempFile}
+++ b/${tempFile}
@@ -1,1 +1,1 @@
-function foo() { return 42; }
+function foo() { return 42; ;;; {{{{ broken syntax`);
  } catch (err) {
    threw = true;
    assert(err.message.includes('syntax error'));
  }
  assert(threw);
  const rolledBack = fs.readFileSync(tempFile, 'utf8');
  assert(rolledBack === 'function foo() { return 42; }\n');
  fs.unlinkSync(tempFile);
  console.log('✓ Syntax error rollback passed');

  // Test 9: Negative - Atomic rollback across multiple files
  console.log('Test 9: Negative - Atomic multi-file rollback');
  const file1 = 'test_f1.js';
  const file2 = 'test_f2.js';
  fs.writeFileSync(file1, 'const f1 = 1;\n');
  fs.writeFileSync(file2, 'const f2 = 2;\n');
  threw = false;
  try {
    await applyDiff(`--- a/${file1}
+++ b/${file1}
@@ -1,1 +1,1 @@
-const f1 = 1;
+const f1 = 100;
--- a/${file2}
+++ b/${file2}
@@ -1,1 +1,1 @@
-this line does not exist in f2
+replacement`);
  } catch (err) {
    threw = true;
  }
  assert(threw);
  assert(fs.readFileSync(file1, 'utf8') === 'const f1 = 1;\n');
  assert(fs.readFileSync(file2, 'utf8') === 'const f2 = 2;\n');
  fs.unlinkSync(file1);
  fs.unlinkSync(file2);
  console.log('✓ Atomic multi-file rollback passed');

  // Test 10: CRLF preservation
  console.log('Test 10: CRLF preservation');
  fs.writeFileSync(tempFile, 'line1\r\nline2\r\nline3\r\n');
  await applyDiff(`--- a/${tempFile}
+++ b/${tempFile}
@@ -2,1 +2,1 @@
-line2
+line2_updated`);
  const crlfContent = fs.readFileSync(tempFile, 'utf8');
  assert(crlfContent.includes('\r\n'));
  assert(crlfContent.includes('line2_updated\r\n'));
  fs.unlinkSync(tempFile);
  console.log('✓ CRLF preservation passed');

  console.log('\nALL 10 TESTS PASSED SUCCESSFULLY! 🚀');
}

runAllTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
