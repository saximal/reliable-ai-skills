---
name: safe-llm-failover
description: Add or review fallback LLM models in an existing streaming client while preserving prompts, cancellation, partial output, and usage accounting. Includes a local SSE fault lab for testing transport decisions without paid model calls.
---

# Safe LLM failover

Use this skill when a streaming LLM client needs fallback candidates, hangs before its first text, loses a continuation, or loses track of usage after an error. Keep the application's existing SDK and product behavior. The included code is a small reference simulator with a synthetic protocol, not a universal production SDK.

## Start with the existing boundary

Inspect the current request builder, SDK retry settings, stream consumer, continuation logic, cancellation signal, and accounting owner. Find where the application first exposes text or other irreversible output. Confirm the permitted models, image support, endpoint/credential boundaries, and total attempt budget from the task and configuration.

Map that boundary to normalized events using [integration.md](references/integration.md). Read it before adapting the example to an SDK. Preserve the original messages, instruction priority, images, and generation constraints on every authorized attempt; fail a capability check rather than silently removing content. A fallback candidate must be appropriate for the same task. These tests do not establish any model's answer quality.

## Preserve the invariants

- Switch candidates only before visible output and only for a classified recoverable provider failure. Once text, tool effects, or other output may have reached a consumer, keep the attempt pinned and return a partial failure if needed.
- A successful earlier segment pins continuations to that model. Failure before a continuation's first new text cannot replay the whole answer or switch models.
- User cancellation stops the chain. Abort the current request and prevent every subsequent attempt. A UI callback or application handler exception is a consumer failure, not a reason for another paid provider request.
- End a first-text timer when the first nonempty text arrives. Separately bound model selection and generation, including continuations. Comments, role frames, and usage frames are not first text.
- Set one explicit total attempt budget, including continuations and all retry owners. Disable hidden SDK retries or count them in the same budget; coordinate job-level retries so they cannot multiply transport attempts.
- Keep per-attempt usage provenance. Add authoritative usage from failed and successful attempts; retain provisional observations separately. Missing or uncertain usage stays unknown, even after a later successful attempt. A timeout or HTTP error does not prove no charge occurred.

Use [decision-matrix.md](references/decision-matrix.md) to select policy for the actual provider. HTTP status alone is insufficient. Candidate IDs, deadlines, token limits, image capabilities, and cooldown policy belong in configuration. In-process cooldown does not provide distributed coordination.

## Prove the behavior locally

Follow [local-lab.md](references/local-lab.md) for runnable commands, examples, and the simulator's limits. The harness uses Node.js built-ins, binds only to loopback, and needs no API key. Keep local tests and real provider validation separate in the report.

For an application change, test the existing adapter with equivalent fault scenarios: fragmented SSE/UTF-8, multiline data and comments, first-text stalls, final versus provisional usage, partial output, continuation failure, cancellation, and consumer exceptions. Check attempt counts and observable output, not just error messages. Report the changed policy, tests actually run, SDK assumptions, and any remaining unverified provider behavior.
