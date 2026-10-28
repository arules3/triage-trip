import assert from 'assert';
import { triageRegression } from '../src/triage.js';
import { extractDiff } from '../src/patch.js';

const MOCK_DIAGNOSIS = `1. **Root Cause**: app.js line 7 — profile.userID does not exist after schema rename.
2. **Attributed Intent**: Git commit renamed userId → user_id in the profile contract.
3. **The Shift**: Caller still reads profile.userID; callee returns profile.user_id.
4. **Patch**:
\`\`\`diff
--- a/app.js
+++ b/app.js
@@ -4,5 +4,5 @@
 function renderDashboard() {
   const profile = getUserProfile("usr_123");
-  console.log(\`Loading dashboard for user ID: \${profile.userID.toUpperCase()}\`);
+  console.log(\`Loading dashboard for user ID: \${profile.user_id.toUpperCase()}\`);
 }
\`\`\`
`;

function createMockAnthropic(capture) {
  return class MockAnthropic {
    constructor(opts) {
      capture.ctorOpts = opts;
    }

    messages = {
      create: async (params) => {
        capture.createParams = params;
        assert.strictEqual(params.stream, true, 'Anthropic create must enable stream: true');

        async function* streamEvents() {
          // Non-text events should be ignored by triage
          yield { type: 'message_start', message: { id: 'msg_mock' } };
          yield { type: 'content_block_start', index: 0 };

          const chunkSize = 40;
          for (let i = 0; i < MOCK_DIAGNOSIS.length; i += chunkSize) {
            yield {
              type: 'content_block_delta',
              delta: {
                type: 'text_delta',
                text: MOCK_DIAGNOSIS.slice(i, i + chunkSize),
              },
            };
          }

          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_stop' };
        }

        return streamEvents();
      },
    };
  };
}

async function runStreamingTests() {
  console.log('Running mocked Anthropic / Windsurf streaming tests...\n');

  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevOpenAI = process.env.OPENAI_API_KEY;
  const prevModel = process.env.ANTHROPIC_MODEL;
  const originalWrite = process.stdout.write.bind(process.stdout);

  try {
    // -------------------------------------------------------------------------
    // Test 1: Mocked Claude (Anthropic) streaming path
    // -------------------------------------------------------------------------
    console.log('Test 1: Mocked Anthropic stream (Claude path)');
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_MODEL = 'claude-mock-test';

    const capture = {};
    const MockAnthropic = createMockAnthropic(capture);

    let streamStartCount = 0;
    const written = [];
    process.stdout.write = (chunk, ...args) => {
      written.push(String(chunk));
      return true;
    };

    const diagnosis = await triageRegression(
      "TypeError: Cannot read properties of undefined (reading 'toUpperCase')",
      {
        branch: 'main',
        untrackedFiles: ['package-lock.json', 'app.js'],
        workingDiff: null,
        recentCommits: [],
        activeFileContents: {
          'app.js': '1| // app.js\n7|   console.log(profile.userID.toUpperCase());\n',
        },
      },
      [
        {
          id: 'sim-claude',
          text: 'Rename userId to user_id in the profile schema.',
        },
      ],
      () => {
        streamStartCount += 1;
      },
      { Anthropic: MockAnthropic },
    );

    process.stdout.write = originalWrite;

    assert.strictEqual(capture.ctorOpts?.apiKey, 'test-anthropic-key');
    assert.strictEqual(capture.createParams?.model, 'claude-mock-test');
    assert.strictEqual(capture.createParams?.stream, true);
    assert.ok(
      capture.createParams?.messages?.[0]?.content.includes('Attributed Prompt'),
      'Cursor-style prompts should request Attributed Prompt',
    );
    assert.strictEqual(streamStartCount, 1, 'onStreamStart should fire once before first token');
    assert.strictEqual(diagnosis, MOCK_DIAGNOSIS, 'returned text must equal concatenated stream');
    assert.strictEqual(written.join(''), MOCK_DIAGNOSIS, 'stdout must receive streamed chunks');
    assert.ok(extractDiff(diagnosis), 'streamed diagnosis must still yield an extractable patch');
    console.log('✓ Mocked Anthropic stream passed');

    // -------------------------------------------------------------------------
    // Test 2: Windsurf-style empty IDE prompts still hit Anthropic when keyed
    // -------------------------------------------------------------------------
    console.log('Test 2: Windsurf empty prompts → Attributed Intent in Anthropic user prompt');
    process.stdout.write = () => true;

    const windsurfCapture = {};
    const WindsurfMockAnthropic = createMockAnthropic(windsurfCapture);

    await triageRegression(
      'TypeError: cannot read toUpperCase',
      {
        branch: 'main',
        untrackedFiles: ['package-lock.json', 'notes.md'],
        workingDiff: 'diff --git a/app.js',
        recentCommits: [],
      },
      [],
      undefined,
      { Anthropic: WindsurfMockAnthropic },
    );

    process.stdout.write = originalWrite;

    const userContent = windsurfCapture.createParams?.messages?.[0]?.content || '';
    assert.ok(
      userContent.includes('No local IDE prompt telemetry available'),
      'Windsurf path should inject Git-only telemetry note',
    );
    assert.ok(
      userContent.includes('Attributed Intent'),
      'Windsurf path should label step 2 as Attributed Intent',
    );
    assert.ok(
      userContent.includes('notes.md'),
      'non-lockfile untracked files should remain in the prompt',
    );
    assert.ok(
      !userContent.includes('package-lock.json'),
      'cleanGitContext should filter lockfiles from untracked files before prompt build',
    );
    console.log('✓ Windsurf empty-prompt Anthropic path passed');

    console.log('\nALL STREAMING MOCK TESTS PASSED! 🚀');
  } finally {
    process.stdout.write = originalWrite;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAI;
    if (prevModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prevModel;
  }
}

runStreamingTests().catch((err) => {
  console.error('Streaming mock test failed:', err);
  process.exit(1);
});
