import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from './sse.mjs';
import { runFailover, ConsumerError, TransportError } from './failover.mjs';
import { openLocal } from './local-adapter.mjs';
import { startFaultServer } from './fault-server.mjs';

async function* bytes(parts) { for (const part of parts) yield part; }
async function collect(parts, options) {
  const result = [];
  for await (const event of parseSse(bytes(parts), options)) result.push(event);
  return result;
}
const messages = [{ role: 'system', content: 'Preserve this instruction.' }, {
  role: 'user', content: [{ type: 'text', text: 'Read the image.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } }],
}];
async function labTest(fn) {
  const lab = await startFaultServer();
  const invoke = (scenarios, options = {}) => runFailover({
    candidates: scenarios.map((scenario, index) => ({
      id: `model-${index + 1}`, endpoint: `${lab.url}/stream?scenario=${scenario}`, supportsImages: true,
    })), messages, open: openLocal, firstTextMs: 2_000, selectionMs: 4_000, generationMs: 4_000,
    ...options,
  });
  try { await fn({ ...lab, invoke }); } finally { await lab.close(); }
}

test('SSE survives every byte split, UTF-8 splits, comments, multiline data, and mixed newlines', async () => {
  const wire = Buffer.from('\uFEFF: heartbeat\r\n\r\nid: 7\revent: delta\rdata: café\rdata: ☕\r\n\r\n' +
    'retry: 200\nunknown: ignored\ndata: next\n\n');
  const expected = [{ event: 'delta', id: '7', data: 'café\n☕' }, { event: 'message', id: '7', data: 'next' }];
  for (let cut = 0; cut <= wire.length; cut++) assert.deepEqual(await collect([wire.subarray(0, cut), wire.subarray(cut)]), expected);
  assert.deepEqual(await collect([...wire].map(value => Uint8Array.of(value))), expected);
});
test('SSE drops unterminated events, keeps empty data, ignores comments, and bounds memory', async () => {
  assert.deepEqual(await collect([Buffer.from(': ping\n\ndata:\n\ndata: unfinished')]), [{ event: 'message', id: '', data: '' }]);
  await assert.rejects(collect([Buffer.from('data: too long\n\n')], { maxEventChars: 8 }), /exceeds/);
  await assert.rejects(collect([Uint8Array.of(0xff)]), /encoded data/);
});
test('real HTTP/SSE fragments and multiline JSON reach the consumer intact', () => labTest(async ({ invoke }) => {
  const fragments = [];
  const result = await invoke(['fragmented'], { onText: text => fragments.push(text) });
  assert.equal(result.text, 'café ☕'); assert.deepEqual(fragments, ['café ☕']);
  assert.equal(result.usage.fullyKnown, true);
}));
test('pre-output transient HTTP failure falls back, preserving messages and images', () => labTest(async ({ invoke, requests }) => {
  const snapshot = structuredClone(messages);
  const result = await invoke(['unavailable', 'success']);
  assert.equal(result.text, 'hello world'); assert.equal(result.model, 'model-2');
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(requests.map(request => request.body.messages), [snapshot, snapshot]);
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(result.usage.unknownAttempts, [1]);
  assert.equal(result.usage.knownInputTokens, 3); assert.equal(result.usage.fullyKnown, false);
}));
test('invalid credentials stop the chain under the default policy', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['auth', 'success']), error => error.status === 401 && error.report.attempts.length === 1);
  assert.equal(requests.length, 1);
}));
test('in-band provider error before text may fall back', () => labTest(async ({ invoke }) => {
  const result = await invoke(['error-before', 'success']); assert.equal(result.model, 'model-2');
}));
test('partial text pins the model and retains provisional usage as unknown', () => labTest(async ({ invoke, requests }) => {
  const visible = [];
  await assert.rejects(invoke(['partial', 'success'], { onText: text => visible.push(text) }), error => {
    assert.equal(error.code, 'overloaded'); assert.equal(error.report.text, 'partial');
    assert.deepEqual(error.report.usage.unknownAttempts, [1]);
    assert.deepEqual(error.report.attempts[0].usage.observed, { inputTokens: 3, outputTokens: 2 });
    return true;
  });
  assert.deepEqual(visible, ['partial']); assert.equal(requests.length, 1);
}));
test('authoritative usage on a failed attempt is added to successful usage', () => labTest(async ({ invoke }) => {
  const result = await invoke(['final-fail', 'success']);
  assert.equal(result.usage.knownInputTokens, 10); assert.equal(result.usage.knownOutputTokens, 3);
  assert.equal(result.usage.fullyKnown, true); assert.deepEqual(result.usage.unknownAttempts, []);
}));
test('intermediate usage without definitive accounting remains unknown after fallback', () => labTest(async ({ invoke }) => {
  const result = await invoke(['interim-fail', 'success']);
  assert.equal(result.usage.knownInputTokens, 3); assert.deepEqual(result.usage.unknownAttempts, [1]);
  assert.equal(result.attempts[0].usage.observed.inputTokens, 7);
}));
test('SSE EOF without completion is a partial failure, not success or a new model', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['missing-done', 'success']), error => error.code === 'stream_interrupted' && error.report.text === 'partial');
  assert.equal(requests.length, 1);
}));
test('malformed provider data is a protocol error rather than an automatic paid retry', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['malformed', 'success']), error => error.code === 'protocol_error');
  assert.equal(requests.length, 1);
}));
test('consumer exceptions retain partial output and never trigger provider failover', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['success', 'success'], { onText: () => { throw new Error('UI unavailable'); } }), error => {
    assert.ok(error instanceof ConsumerError); assert.equal(error.cause.message, 'UI unavailable');
    assert.equal(error.report.text, 'hello '); return true;
  });
  assert.equal(requests.length, 1);
}));
test('cancellation after output aborts the chain', () => labTest(async ({ invoke, requests }) => {
  const controller = new AbortController();
  const reason = new Error('User cancelled');
  await assert.rejects(invoke(['hang-after', 'success'], {
    signal: controller.signal, onText: () => controller.abort(reason),
  }), error => error === reason && error.report.text === 'A');
  assert.equal(requests.length, 1);
}));
test('already cancelled requests make no HTTP attempt', () => labTest(async ({ invoke, requests }) => {
  const controller = new AbortController(); controller.abort(new Error('Already cancelled'));
  await assert.rejects(invoke(['success'], { signal: controller.signal }), /Already cancelled/);
  assert.equal(requests.length, 0);
}));
test('continuations use the pinned model, original multimodal prompt, and committed text', () => labTest(async ({ invoke, requests }) => {
  const result = await invoke(['continuation', 'success'], { maxAttempts: 3 });
  assert.equal(result.text, 'part one part two'); assert.equal(result.model, 'model-1');
  assert.deepEqual(requests.map(request => request.scenario), ['continuation', 'continuation']);
  assert.deepEqual(requests[1].body.messages, messages);
  assert.deepEqual(requests[1].body.continuation, { index: 1, text: 'part one ' });
  assert.equal(result.usage.knownInputTokens, 8);
}));
test('continuation failure before its first text cannot replay the earlier successful part', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['continuation-failure', 'success'], { maxAttempts: 3 }), error => {
    assert.equal(error.report.text, 'part one '); assert.equal(error.report.attempts.length, 2);
    assert.deepEqual(error.report.usage.unknownAttempts, [2]); return true;
  });
  assert.deepEqual(requests.map(request => request.scenario), ['continuation-failure', 'continuation-failure']);
}));
test('total attempt budget includes continuations', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['continuation', 'success'], { maxAttempts: 1 }), error => error.code === 'attempt_budget' && error.report.text === 'part one ');
  assert.equal(requests.length, 1);
}));
test('explicit continuation limit stops before starting another request', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['continuation'], { maxContinuations: 0 }), error => error.code === 'continuation_budget');
  assert.equal(requests.length, 1);
}));
test('total failed-attempt budget prevents retry multiplication', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['unavailable', 'unavailable', 'success'], { maxAttempts: 2 }), error => error.report.attempts.length === 2);
  assert.equal(requests.length, 2);
}));
test('first-text deadline retries a comment-only stream', () => labTest(async ({ invoke, requests }) => {
  const result = await invoke(['wait-before', 'success'], { firstTextMs: 100 });
  assert.equal(result.model, 'model-2');
  assert.equal(result.attempts[0].error.code, 'first_text_timeout'); assert.equal(requests.length, 2);
}));
test('first-text deadline is cleared after text, allowing a longer answer', () => labTest(async ({ invoke }) => {
  const result = await invoke(['slow-after'], { firstTextMs: 150 });
  assert.equal(result.text, 'AB');
}));
test('selection deadline bounds the whole candidate search', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['wait-before', 'success'], { firstTextMs: 2_000, selectionMs: 100 }), error => error.code === 'selection_timeout');
  assert.equal(requests.length, 1);
}));
test('generation deadline bounds a stalled response after text without switching models', () => labTest(async ({ invoke, requests }) => {
  await assert.rejects(invoke(['hang-after', 'success'], { generationMs: 100 }), error => error.code === 'generation_timeout' && error.report.text === 'A');
  assert.equal(requests.length, 1);
}));
test('completed empty output is distinct from missing completion', () => labTest(async ({ invoke }) => {
  const result = await invoke(['empty']); assert.equal(result.text, ''); assert.equal(result.attempts[0].status, 'succeeded');
}));
test('capability mismatch fails before submitting or dropping images', async () => {
  let calls = 0;
  await assert.rejects(runFailover({ candidates: [{ id: 'text-only', supportsImages: false }], messages,
    open: () => { calls++; },
  }), error => error.code === 'capability_mismatch');
  assert.equal(calls, 0);
});
test('an adapter cannot mutate the prompt passed to the next candidate', async () => {
  let calls = 0; const snapshot = structuredClone(messages);
  const result = await runFailover({ candidates: [{ id: 'a', supportsImages: true }, { id: 'b', supportsImages: true }], messages,
    open: async function* (request) {
      calls++;
      if (calls === 1) { request.messages[0].content = 'mutated'; throw new TransportError('transient', 'try next', { retryable: true }); }
      assert.deepEqual(request.messages, snapshot);
      yield { type: 'text', text: 'ok' }; yield { type: 'finish', reason: 'stop' }; yield { type: 'done' };
    },
  });
  assert.equal(result.text, 'ok'); assert.deepEqual(messages, snapshot);
});
test('lab adapter rejects nonlocal URLs before attempting a connection', async () => {
  const iterator = openLocal({ candidate: { endpoint: 'https://example.invalid/stream' }, messages: [], continuation: null, signal: new AbortController().signal });
  await assert.rejects(iterator.next(), error => error.code === 'local_only');
});
