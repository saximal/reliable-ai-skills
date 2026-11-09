---
name: production-delta-release
description: Plan and verify a narrowly scoped production patch when the working checkout contains unrelated changes. Compare complete file inventories against an exact change manifest and prepare evidence-based activation and rollback.
license: MIT
---

# Production delta release

The inventory helpers require Python 3.10+. Deployment adapters depend on the target environment.

Use the user's existing release process and identify the exact change to deliver. Record the current deployed revision or immutable image digest, its build inputs, the intended patch, and the services that may restart.

Prefer a clean checkout of the deployed source plus the reviewed patch. A runtime delta is appropriate only when provenance and build equivalence can be established. Dependency changes, incompatible compilers and database migrations require a release plan that handles those changes explicitly.

## Prove the candidate

1. Capture a complete baseline inventory from the actual release artifact. Hash files, preserve relative paths, and record image configuration separately. The helper refuses symlinks, so adapt inventory collection explicitly for images containing them.
2. Build the intended patch against that baseline. When recompiling only selected modules, first compile their old source and verify byte equivalence with the deployed modules. Investigate mismatches before claiming an isolated change.
3. Describe every intended added, changed or removed file with its exact old and new SHA-256. Compare the full candidate inventory with the baseline using `scripts/inventory.py` and that manifest. Include generated artifacts in the comparison.
4. Compare normalized runtime environment, mounts, entrypoints, identities and service configuration. Preserve old versioned assets needed by existing clients. File equality alone does not establish configuration or application correctness.
5. Run the feature's normal entry points and negative cases on the candidate in an isolated environment. Record which external integrations were simulated.

Read [the tutorial and manifest example](references/tutorial.md) for runnable offline commands. Read [activation and recovery](references/activation.md) when preparing an actual release adapter. The bundled demo performs a transaction inside a new temporary directory.

## Activate within the authorized scope

Recheck deployed identities and source hashes immediately before each write. Serialize the release with a lock or equivalent ownership mechanism. Capture the previous images, sources and queue states. Pause only queues this operation owns, allow active work to drain with a bounded deadline, and activate mutually dependent services together.

Include readiness, installed hashes, environment checks, public feature checks and restoration of owned queues inside the success transaction. A failure restoring a queue is a release failure. If a partial resume started new work, pause owned queues again and attempt a bounded drain before recovery.

Rollback both runtime and source changes under the same checks. Archive newly introduced files. On concurrent changes or an unknown activation outcome, inspect current state and the saved receipt before deciding the next action. Repeating an uncertain activation can overwrite recovery evidence or duplicate side effects.

## Deliver evidence

Report the baseline and candidate identities, the exact file delta, executed checks, activation outcome, queue restoration and rollback status. Identify remaining assumptions, especially filesystem race protection, shared-file mounts and external side effects. Keep deployment credentials and private source content out of receipts.
