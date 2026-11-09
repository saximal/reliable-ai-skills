# Integrating with an existing SDK

Keep the existing SDK. The files under `scripts/` illustrate a boundary and tests; they do not contain model catalogs, credentials, provider request schemas, token pricing, or production persistence. Inspect installed SDK behavior and the provider's current documentation when implementing a real adapter.

## Minimal callable example

Save this as `example.mjs` beside `SKILL.md` and run `node example.mjs` from the skill directory. The adapter returns normalized synthetic events, so this first exercise runs without a server or SDK.

```js
import { runFailover, TransportError } from './scripts/failover.mjs';

async function* open({ candidate, messages, continuation, signal }) {
  if (signal.aborted) throw signal.reason;
  if (candidate.id === 'primary') {
    throw new TransportError('unavailable', 'Synthetic temporary outage', {
      retryable: true,
      status: 503,
    });
  }
  yield { type: 'text', text: 'A synthetic answer.' };
  yield { type: 'usage', inputTokens: 8, outputTokens: 4, final: true };
  yield { type: 'finish', reason: 'stop' };
  yield { type: 'done' };
}

try {
  const report = await runFailover({
    candidates: [{ id: 'primary' }, { id: 'backup' }],
    messages: [{ role: 'user', content: 'Synthetic example question' }],
    open,
    maxAttempts: 2,
    maxContinuations: 0,
    onText: fragment => process.stdout.write(fragment),
  });
  console.log('\n' + JSON.stringify(report));
} catch (error) {
  console.error(error.code ?? error.name);
  process.exitCode = 1;
}
```

The report selects `backup` and retains the primary attempt's unknown usage. The adapter must use `messages` and map `continuation` when integrating the real request builder. `signal` belongs on the SDK request and stream reader.

`new TransportError(code, message, { retryable = false, status } = {})` stores the code, retryability and optional HTTP status. The default classifier permits fallback for a retryable `TransportError` before output. Throw application/consumer exceptions as their original errors. Supply a custom `classify(error)` only when it preserves origin distinctions and implements the actual provider policy.

## Map the boundary

| Existing application responsibility | Normalized boundary in the reference | Integration decision |
|---|---|---|
| Request builder | `messages`, immutable snapshot; fresh clone for each attempt | Preserve all instruction roles, text, images, constraints, and tool context; do not shorten input during fallback without an explicit product rule |
| Candidate configuration | `{ id, supportsImages, ...adapterConfig }` | Confirm modality and tool support; reject incompatibility before submitting; do not infer support from a model name |
| SDK stream constructor | `open({ candidate, messages, continuation, signal })` | Return an async iterable, disable hidden SDK retries, forward abort, and classify SDK/provider failures |
| Content delta | `{ type: 'text', text: '...' }` | Emit only user-facing text; role deltas and empty strings do not stop a first-text timer |
| Usage frame or response metadata | `{ type: 'usage', inputTokens, outputTokens, final }` | Set `final: true` only when the provider contract establishes definitive per-request totals |
| Finish metadata | `{ type: 'finish', reason: 'stop' | 'length' }` | Map refusal, filtering, tool calls, and other reasons to explicit application outcomes; do not collapse them into ordinary success |
| Terminal completion | `{ type: 'done' }` | Require the provider's documented successful terminal condition; socket EOF alone is insufficient |
| User abort | The same `AbortSignal` through queue, adapter, body reader, and consumer | Cancel locally and suppress future attempts; remote billing may continue |
| Provider failure | Throw an `Error`, classified by origin and retryability | SDK, parser, consumer, and job-owner errors must remain distinguishable |
| Continued answer | `continuation: { index, text }` on the same candidate | Map committed output to the provider's supported continuation contract, while preserving original messages/images and context limits |

The `openLocal` adapter accepts only loopback HTTP and understands the lab's synthetic events. Replace that boundary when testing an actual SDK. Do not send this synthetic wire format to a provider endpoint. The reference `hasImages` capability guard recognizes `image`, `image_url`, and `input_image` content parts; other modalities and provider-specific shapes require the application's own validation.

An adapter may surface definitive usage on a failed request before throwing. If the SDK carries usage on an exception instead, normalize and record it before propagating the failure. The reference accepts only nonnegative integer input/output token counts; cached tokens, reasoning tokens, audio, tool charges, or provider currency require explicit additional fields. Do not invent token counts for missing values.

## Request and usage state

The reference total attempt budget includes fallback and continuation requests. One candidate is tried once during selection; a recoverable pre-output failure advances to the next candidate. There are no hidden retries or same-candidate retry loops. A length-limited successful segment can start another request on the same candidate within both `maxAttempts` and `maxContinuations`. The generation deadline spans those segments.

The first-text timer applies to each started request. The selection deadline is cleared on the first visible text. The generation deadline starts then and continues across follow-up segments. If the answer is complete without text, it may succeed without starting a generation timer. An incomplete stream with no terminal marker is a failure.

Each attempt records status and usage as:

```json
{
  "number": 1,
  "model": "candidate-a",
  "continuation": 0,
  "status": "failed",
  "usage": {
    "known": false,
    "observed": { "inputTokens": 7, "outputTokens": 1 },
    "final": null
  }
}
```

An authoritative usage event stores `final` and sets `known: true`, even when the request later fails. A provisional observation never makes accounting fully known by itself. The summary exposes `knownInputTokens`, `knownOutputTokens`, `unknownAttempts`, and `fullyKnown`. Zero known tokens with a nonempty `unknownAttempts` array is an incomplete ledger, not a free request. `final: true` on the synthetic wire is an explicit fixture contract, not a heuristic based on a field's name or stream position.

These are token subtotals, not a money total. Production pricing should apply per-attempt model, rate version, cache categories, and charge units. Retain the provider request identifier and accounting provenance where available, reconcile uncertain charges, and keep the billing ledger distinct from any user-facing quota policy.

Failures attach the same report to `error.report`; partial text can be sensitive. Integrate it with application state without logging prompts, images, credentials, or generated content by default. Safe diagnostics normally need attempt counts, model/endpoint aliases, error origin, duration, finish state, and usage certainty. The demo prints synthetic output only.

## Scope and adaptations

The reference contains no SDK integration, persistent job leases, distributed cooldown, idempotency store, billing reconciliation, resumable tool execution, or durable checkpoints. A callback that ignores its abort signal can continue its own side effects after the orchestrator stops waiting; application consumers must cooperate with cancellation. An adapter must also terminate and release resources on abort. Before enabling real candidates, run equivalent tests through the actual SDK and verify its stream completion, usage, error, and cancellation contracts. Passing this harness proves local policy behavior, not every model's protocol or answer quality.
