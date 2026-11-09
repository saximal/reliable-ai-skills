# Local SSE fault lab

The examples use Node.js built-ins and require Node.js 20+ with `fetch`, `structuredClone`, and the built-in test runner. The initial acceptance suite ran on Windows with Node.js 24.22.1. Validate the SDK and runtimes supported by your application when adapting the harness. All example inputs are synthetic and all HTTP servers bind to loopback.

From the skill directory (the directory containing `SKILL.md`), run:

```sh
node --test scripts/failover.test.mjs
node scripts/demo.mjs fallback
```

The fallback demo starts a server on a random `127.0.0.1` port, gets a synthetic HTTP 503 from the first candidate, then returns `hello world` from the second candidate. Its report contains two attempts, known usage for the successful one, and unknown accounting for the failed one. The process closes the server before exiting.

Try the other observable outcomes:

```sh
node scripts/demo.mjs partial
node scripts/demo.mjs continuation
node scripts/demo.mjs continuation-failure
node scripts/demo.mjs usage
node scripts/demo.mjs fragmented
node scripts/demo.mjs cancel
node scripts/demo.mjs consumer
```

| Case | Expected result |
|---|---|
| `partial` | One attempt, partial text, provider error; second candidate is untouched |
| `continuation` | Two requests on candidate 1; original messages and committed text retained |
| `continuation-failure` | Earlier text retained; failed follow-up does not switch or replay |
| `usage` | Failed authoritative 7/1 tokens plus successful 3/2 tokens gives known 10/3 totals |
| `fragmented` | UTF-8 text `café ☕` survives multiline SSE data and byte fragments |
| `cancel` | Cancellation after `A` stops the whole chain |
| `consumer` | A synthetic UI exception becomes `consumer_error`; no fallback |

Expected fault demos print their report and exit successfully so the examples can be run as a batch. The test runner, rather than the demo exit code, asserts the expected behavior.

## Inspect an HTTP stream directly

In one terminal:

```sh
node scripts/fault-server.mjs --port 8787
```

In a second terminal (PowerShell use `curl.exe` instead of `curl` if needed):

```sh
curl -N -X POST -H "Content-Type: application/json" --data "{}" "http://127.0.0.1:8787/stream?scenario=fragmented"
```

Stop the server with Ctrl+C. It binds only to `127.0.0.1`; the CLI has no public-host option. The lab adapter also rejects non-loopback URLs and redirects. Requests stay in memory for assertions and are not logged or written to disk. Use synthetic inputs.

## Fixtures and protocol

`fault-server.mjs` exposes `POST /stream?scenario=...`. The body is `{ messages, continuation }`. Supported scenarios are `success`, `unavailable`, `auth`, `redirect`, `wait-before`, `hang-after`, `slow-after`, `partial`, `final-fail`, `interim-fail`, `error-before`, `missing-done`, `malformed`, `empty`, `continuation`, `continuation-failure`, and `fragmented`. Unknown scenarios fail explicitly. The two hanging scenarios end when the client aborts or the server closes.

The synthetic SSE payloads use JSON objects with normalized `text`, `usage`, `finish`, or `error` types, followed by `data: [DONE]`. This is deliberately a lab protocol. Network writes can be combined by the OS, so separate parser tests force every byte split, including inside UTF-8 characters and CRLF. Parser coverage includes comments, multiline data, mixed line endings, incomplete final frames, and size limits.

Tests then cross the real local HTTP boundary to assert candidate counts, exact delivered text, preserved multimodal prompts, cancellation, malformed data, known/unknown usage, continuation budgets, and first-text/selection/generation deadlines. Timer tests use bounded waits; they require a machine capable of scheduling a local HTTP exchange within the configured short fixture deadlines. Production timeout values must be measured for the application and provider.

For a new integration, reuse the assertions with the existing SDK adapter and a provider-shaped local fixture. Record which conditions were verified locally and which require an authorized live-provider check. Do not turn a local simulator pass into a claim that production SDKs or models were all tested.
