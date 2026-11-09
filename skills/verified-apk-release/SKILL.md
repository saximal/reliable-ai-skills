---
name: verified-apk-release
description: Verify a directly distributed Android APK, its signing identity, delivered local copies, and full HTTPS downloads before preparing a separate release candidate manifest.
---

# Verified APK Release

Use this workflow for direct APK distribution, stale download links, or uncertain package/version/signature evidence. It requires an existing built APK; it does not build an application or publish a release.

Read [the workflow and tutorial](references/workflow.md) for configuration, dependencies, signer limitations, and the local fixture exercise.

Obtain the intended application ID, exact versionName/versionCode, approved current signer certificate SHA-256 set, delivered local copy paths, download URLs/allowed hosts, and a fresh candidate output path. Obtain signer fingerprints from an established trusted release record or approved key owner; copying them from the APK under examination would defeat the identity check. Preserve any authorization already given for publication without expanding its scope.

Use real Android SDK Build Tools (`aapt` and `apksigner.jar`) and Java for actual release verification. Configure their locations explicitly. The dependency-free Node 20+ helper does not replace these tools with a ZIP filename or manifest heuristic.

Run the helper from this skill directory, using the configured paths:

```text
node scripts/verify-apk.mjs verify --config /path/to/release-check.json
```

The helper freezes the original digest before invoking external tools, inspects a private snapshot, rejects debuggable builds and recognizable Android Debug signing subjects, requires a successful cryptographic verification and the exact expected current signer set, and rechecks the original and snapshot after external steps. It hashes each delivered copy and each complete GET response, enforcing exact size/digest, HTTPS, host allowlists, redirect limits, and deadlines. A candidate appears atomically at a new path only after all checks pass.

Treat the output as a reviewable candidate. The helper contains no publishing command. After any separately authorized upload/staging step, verify the real destination URLs; before activating a release, follow the project's publication process and confirm existing authorization covers that action. Reverify changed or expired evidence. A renamed fixture report, HTTP HEAD, source configuration version, or successful upload is insufficient release evidence.

If the SDK, approved identity, delivered copy, or real HTTPS endpoint is unavailable, report that specific gap. Use `fixture` only to exercise the helper locally: it restricts requests to loopback and emits an explicitly unverified `.fixture.json` report with `releaseEligible: false`. Do not claim a synthetic fixture proves an authentic APK, working Android installation, update compatibility, or real server delivery.

For key rotation, multiple signing variants, store signing, or Android-version-specific identities, resolve the intended signing policy externally. The helper compares the observed current signer set exactly; it does not infer a rotation policy or prove an upgrade path from an installed app. Debug subject detection and a configurable denylist supplement an approved signer set; neither identifies every possible development key.

Run the focused offline suite after changing the helper:

```text
node --test tests/verify-apk.test.mjs
```
