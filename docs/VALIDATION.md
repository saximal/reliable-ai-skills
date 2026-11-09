# Validation scope

## Run the suite

From the repository root, use Python 3.10+ and Node.js 20+.

```sh
python -m venv .venv
```

Activate the environment using the command appropriate for your shell, then install the development dependencies and run the checks.

```sh
python -m pip install -r requirements-dev.txt
python -B scripts/run_checks.py
```

On Windows, the environment's interpreter can be used directly.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -B scripts/run_checks.py
```

The runner checks skill metadata and local documentation links, Python diagnostics and inventories, installer behavior, Node streaming and APK fixture scenarios, and the temporary delta-release demo. It uses local fixtures and loopback servers. Development dependency installation requires access to the package registry.

## What is exercised

| Package | Evidence from the offline suite |
| --- | --- |
| PDF diagnostics | Layer selection, encoding flags, malformed inputs, sanitized errors, page ranges, preserved outputs, generated PDF text and image-only pages |
| LLM failover | SSE fragmentation and UTF-8, provider errors, first-text deadlines, generation deadlines, cancellation, consumer errors, continuation pinning and usage confidence |
| APK verification | Synthetic metadata tools and local delivery, package/version/certificate mismatches, byte integrity, delivery limits, output preservation and fixture-only labeling |
| Delta release | Exact allowed change/add/remove, wrong baseline, extra files, invalid manifests, preserved receipts and guarded temporary rollback |
| Installer | Dry run, exact copied entry point, existing-install preservation, selection validation and destination boundaries |

The independent forward checks use a fresh task and synthetic inputs with the public skill instructions. They exercise the documented entry points and inspect the actual output. Evidence generated during development stays outside published package contents.

## Integration boundaries

The PDF checker flags technical text-layer quality. Domain accuracy, OCR recognition quality, search recall and actual model access to page images require corpus-specific checks. The bundled helper produces diagnostics and recommendations. An application must implement the selected repair and rebuild affected index/cache state.

The LLM harness models a normalized adapter contract. Integrating a provider requires mapping its stream, errors, continuation protocol, capability limits and usage rules. The offline suite makes no paid provider requests.

The APK suite uses synthetic bytes and mock metadata tools. Authentic APK signature verification requires Android SDK Build Tools, Java, a real release artifact and the expected signer set. Device installation, signing-key rotation and updater behavior require separate acceptance testing.

The delta helper checks regular-file inventories. Image configuration, ownership, permissions, symlinks, queues, database migrations and external side effects require appropriate deployment adapters and release checks.

## Environment coverage

Initial local checks run on Windows with Python 3.12.14, `pypdf` 6.10.0 and Node.js 24.22.1. The GitHub workflow defines Linux Python 3.10/Node 20, Linux Python 3.13/Node 22, Windows Python 3.13/Node 24 and macOS Python 3.13/Node 24 jobs. Workflow definitions and local runs are distinct evidence. Consult the commit's Actions result for executed CI coverage.

The instruction packages were reviewed with independent AI-agent tasks. Compatibility with a particular model, context window and host client requires testing in that environment.
