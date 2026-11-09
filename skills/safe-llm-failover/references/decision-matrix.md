# Decision matrix

This table is a starting policy for an authorized candidate chain. Provider error bodies, quota scope, request semantics, and endpoint changes can override a status-based guess. Explicitly configure ambiguous cases rather than guessing whether another paid call is safe.

| Observation | Before visible output | After output or an earlier successful continuation segment | Accounting |
|---|---|---|---|
| User cancellation | Abort and stop the whole chain | Abort and return cancelled/partial status | Preserve known usage; unresolved requests may still incur charges |
| Consumer callback, persistence, or UI handler error | Stop; expose an application error | Stop; preserve partial state | Do not classify it as a provider outage |
| Invalid credentials, rejected request, unsupported parameter, safety refusal | Fix configuration or return the typed outcome; no blind retry | Stop | Do not infer zero cost from the status |
| Rate limit | Distinguish temporary rate limit from exhausted account quota; obey bounded delay and shared budget if configured | Stop/partial failure | Keep any explicit usage; retain unknown charge status otherwise |
| Temporary outage, connection error, first-text timeout | Next authorized candidate may be allowed within selection deadline and budget | Stop/partial failure; no cross-model replay | Treat definitive usage and provisional observations separately |
| Invalid JSON, unsupported event shape, missing expected finish metadata | Surface protocol incompatibility; investigate adapter before retrying | Stop/partial failure | Preserve usage already observed |
| EOF or socket error before completion marker | May retry if no output was exposed and policy permits | Stop/partial failure, even if some usage arrived | Intermediate usage alone is not necessarily authoritative |
| Length limit with a complete segment | Continue on the same model if budget and product contract permit | Continue with committed context on the pinned model | Account for each continuation request separately |
| Generation deadline | Stop | Abort and return partial failure | Preserve known and unknown attempts |
| Selection deadline or total attempt budget exhausted | Stop | Stop | Include every started attempt in the ledger |

"Visible" means output may have escaped the transport boundary. A consumer can write a fragment and then throw, so pin before invoking it. For tool calls, external effects, audio, or structured outputs, define the equivalent irreversible boundary in the existing application. The reference lab models text only.

The lab's intentionally small default classifier retries HTTP 408, 429, 500, 502, 503, and 504 plus normalized transient network/stream failures before output. It stops on malformed JSON and other protocol errors, 401/403, cancellation, and consumer errors. This is a demonstration policy, not a provider compatibility claim. A connection failure can still correspond to a billable request.

There is no automatic backoff or cooldown in the simulator. Add a provider-aware delay only if it fits the remaining selection deadline, honors cancellation, and cannot extend the total budget. Changing accounts or regions to bypass a restriction is not implied by a fallback requirement. Use already authorized endpoints and credentials.

Do not automatically restart a background job after partial generation. A job retry needs durable partial-output and request-accounting state plus an explicit resume/restart policy. Local transport cancellation cannot promise the provider stopped computing or billing, and this workflow does not offer exactly-once paid calls.
