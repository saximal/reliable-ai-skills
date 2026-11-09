# Workflow, configuration, and local tutorial

## Evidence and dependencies

The release path checks bytes using real Android SDK Build Tools and Java. Install those tools through the normal trusted toolchain for the project; point at an existing SDK installation. No npm package, paid service, platform-specific shell, or mobile application change is required. Node 20+ runs the helper on Windows, macOS, and Linux. The filesystem holding reports must support hard links for atomic creation without replacement; an unsupported filesystem causes failure.

Use `aapt` (not `aapt2`) with `dump badging`. The helper runs Java with `-jar apksigner.jar verify --verbose --print-certs`, requires exit status zero, parses current signer certificate SHA-256 lines and subjects, and requires a verified v2, v3, or v3.1 scheme. It deliberately rejects v1-only APKs. Use the same SDK family approved for the project. Unrecognized output fails closed. Do not rename a shell launcher to `java` or use a batch wrapper: configure a native Java executable and the actual signer JAR.

Real signing verification needs a genuine APK, the SDK/JDK, and a separately trusted expected signing identity. The included tests use text files and fake tools; they do not validate the SDK integration or any real signing identity. Run a real verification with your own approved artifact/toolchain before relying on this workflow in production.

## Real verification tutorial

1. Finish the APK build. Pause processes that might overwrite that artifact. Get the intended application ID, versionName, versionCode, and approved certificate fingerprint set from the release owner or established trusted records. Know whether the delivered APK uses a store signing key, upload key, or direct-distribution key.
2. Under the project's existing authorization, stage exact copies at the required local and remote delivery destinations. Choose immutable/versioned remote object names where possible. This helper does not upload files. Do useful local preparation before any required approval for an external mutation; existing explicit authorization remains valid.
3. Save a config JSON file next to the artifact or elsewhere. All file paths are resolved relative to that config file, while a bare `java` command uses PATH. Use forward slashes in JSON on Windows, or escape backslashes. Replace every illustrative value below with the project's actual values, especially the signer fingerprint.

```json
{
  "apk": "./build/app-release.apk",
  "copies": ["./delivery/app-release.apk"],
  "packageName": "org.example.demo",
  "versionName": "2.4.0",
  "versionCode": 240,
  "expectedSignerSha256": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "denySignerSha256": [],
  "urls": ["https://downloads.example.invalid/releases/app-2.4.0.apk"],
  "allowedHosts": ["downloads.example.invalid"],
  "tools": {
    "aapt": "/path/to/android-sdk/build-tools/VERSION/aapt",
    "java": "java",
    "apksignerJar": "/path/to/android-sdk/build-tools/VERSION/lib/apksigner.jar"
  },
  "output": "./reports/app-2.4.0.candidate.json",
  "maxBytes": 536870912,
  "maxRedirects": 0,
  "timeoutMs": 120000,
  "toolTimeoutMs": 60000
}
```

The `a…a` fingerprint is fictional, not an approved certificate. The `.invalid` domain cannot serve a real release. On Windows set `aapt` to the SDK's `aapt.exe` and optionally use an absolute path to `java.exe`. On macOS/Linux configure native executables with execute permissions.

4. From this skill directory run:

```text
node scripts/verify-apk.mjs verify --config /path/to/release-check.json
```

5. Review the new candidate. Its `kind` must be `apk-release-candidate`, verification status `verified`, and `releaseEligible` true. It records observed package/version, original byte length/SHA-256, current signer fingerprints, signature schemes, and each requested/final download URL. The helper creates a complete new file atomically and refuses to overwrite any existing output. Name a fresh candidate for each run.
6. Use the project's authorized publishing process to activate the reviewed candidate, including version monotonicity, release notes, and any application-specific manifest schema. This skill does not define the app's production manifest or replace its publisher. Before promotion, check authorization and fresh evidence for the actual destination; the helper does not authorize publication or guarantee a remote file remains unchanged after the check.

Never configure the active production manifest as the output. Release outputs must end with `.candidate.json`; fixture outputs must end with `.fixture.json`. These filename guards reduce accidental replacement, and all existing outputs are also protected by atomic creation without replacement. Content checks remain necessary: renaming a report does not change its meaning.

## Configuration details

| Field | Required behavior |
| --- | --- |
| `apk` | Existing nonempty regular file; source symlinks are rejected. |
| `copies` | 1–32 existing independently delivered regular files, distinct from the source and each other. Each must match source size and SHA-256 exactly. No copy or overwrite is performed. |
| `packageName`, `versionName`, `versionCode` | Exact expectations; printable nonempty versionName, integer versionCode 1–2100000000. Values come from actual `aapt` output, not source configuration. |
| `expectedSignerSha256` | Exact set of 1–16 unique current signing certificate SHA-256 hex digests (64 hex digits each); case is normalized. This is not a list of interchangeable allowed keys. |
| `denySignerSha256` | Optional extra known development/revoked certificate fingerprints. An expected fingerprint also on this list is rejected. |
| `urls` | 1–32 complete GET URLs to check; no URL credentials or fragments. Do not put credentials or signed secrets in URLs/configs/candidates intended for sharing. |
| `allowedHosts` | Lowercase exact URL hosts, including port if present; no wildcards. Every redirect target is checked against this list. |
| `maxBytes` | Default 512 MiB; supported range 1 byte–4 GiB. Empty, oversize, truncated, extra-byte, and wrong-hash data fails. |
| `maxRedirects` | Default 0; integer 0–5. An allowed redirect still requires HTTPS and an allowed exact host for releases. HTTPS-to-HTTP is always rejected. |
| `timeoutMs` | Total per-URL deadline, including redirects/body; default 120000 ms, maximum 600000 ms. |
| `toolTimeoutMs` | Per external-command timeout; default 60000 ms, maximum 600000 ms. Output is capped at 4 MiB per invocation. |
| `tools` | Native `aapt`, native `java`, and `apksignerJar` paths/command as shown above. The configured toolchain and PATH must be trusted. |
| `output` | New report path; never overwritten. The report has schema version 1. |

All downloaded responses must return HTTP 200. The helper streams the entire response, requests identity encoding, rejects nonidentity Content-Encoding, checks Content-Length when provided, and independently measures the byte stream and SHA-256. Chunked responses are allowed; an absent Content-Length does not remove the exact-size requirement. System proxy variables are not used by this native Node client. The client explicitly enables normal HTTPS certificate/hostname verification even when the surrounding environment disables the default. Choose a directly reachable endpoint; custom TLS bypasses are unsupported.

## Signing and evidence limits

The expected set is compared to the current signer certificates emitted by the configured `apksigner`, with no missing or extra signer accepted. A successful tool invocation and v2/v3 verification are required in addition to fingerprint equality. An apparent Android Debug certificate subject is rejected even if its fingerprint was configured; supply known development key fingerprints in `denySignerSha256` as well. Arbitrarily renamed development certificates cannot be identified generically: the independently approved expected identity is the primary control.

Key rotation and Android-specific signer selection require a project decision. Do not list both old and new keys to mean “either is okay”: that asks for an APK with both current signers, which is different. This helper does not establish certificate lineage, authorize rotation, select among device API-specific signing variants, or prove update compatibility with an installed version. Output formats outside the supported current-signer lines fail. Store-managed app signing and direct distribution may use different signing identities; do not substitute an upload key without verifying what signs the distributed APK.

Before tools run, the helper freezes the original SHA-256/size and copies it to a private temporary snapshot. It rehashes the original and snapshot after each tool and around downloads, then rehashes all tracked delivered copies before candidate creation. This catches persistent rebuilds, changed snapshots, and changed copies in those intervals. It is not an operating system lock or defense against a hostile process that changes and restores bytes between observations. Keep artifacts immutable during verification. A report is an unsigned observation, not a cryptographic attestation of the verifier/toolchain.

A passing candidate does not prove device installation, Android permission flows, update acceptance, runtime behavior, malware safety, or freshness after the recorded instant. Perform the applicable device and release-policy checks separately. A failure leaves no candidate; already staged files are not deleted or rolled back by this helper.

## Private loopback fixture exercise

Run the suite from this skill directory:

```text
node --test tests/verify-apk.test.mjs
```

This reproducible exercise needs only Node. It creates temporary text bytes named `.apk`, two fake Android command adapters, a dummy `.jar`, and an ephemeral HTTP server bound to `127.0.0.1`. It uses no real APK, real signing certificate, internet access, or Android SDK. Temporary artifacts are removed afterward. The success assertion proves orchestration, byte equality, and report labeling, not APK authenticity or crypto.

The fixture CLI shares the validation/digest pipeline but produces a deliberately different report type:

```text
node scripts/verify-apk.mjs fixture --config /path/to/local-fixture.json
```

For your own fixture config, supply the same required fields, loopback-only URLs/allowed hosts, and an output ending `.fixture.json`. Optional `fixtureToolPrefixes` may prepend argument arrays to `tools.aapt` and `tools.java` so a local Node test adapter can stand in for a native executable. The included suite demonstrates this directly. Release mode rejects that field. A fake tool is always a test double, even if it prints plausible Android output.

Fixture requests accept only `127.0.0.1`, `[::1]`, or `localhost`; `localhost` is pinned to `127.0.0.1` by the client rather than resolved externally. Allowlisting an external host does not exempt it from the loopback restriction. Checks run on every redirect and TLS downgrade remains forbidden. Fixture output has `kind: unverified-apk-fixture-report`, `status: unverified-fixture`, `releaseEligible: false`, and false authentic-metadata/crypto checks. No command can promote this report. A real release requires a fresh `verify` run with real SDK tools, approved signer identity, and HTTPS delivery.

The suite covers package/version mismatch, debuggable flag, exact signer sets, development subjects, denylist, tool failure/timeout, source/snapshot/copy mutations, same-size wrong bytes, truncated/oversize bodies, response status/encoding/length, redirects and host restrictions, stalled downloads, output races, and command-line path resolution. It does not assert that fake output proves an authentic APK.
