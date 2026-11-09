# Verify a narrow file delta

Run these commands from the repository root with Python 3.10 or newer. All helpers use the standard library.

```sh
python skills/production-delta-release/scripts/demo_release.py
python -m unittest discover -s skills/production-delta-release/tests -v
```

The demo builds a candidate in a temporary directory, approves its exact hash delta, simulates a readiness failure and verifies recovery to the baseline. It prints `rollbackVerified: true`. The temporary directory is automatically removed. Adapt the transaction to your release system only after reviewing [activation and recovery](activation.md).

## Use your own artifact directories

Capture immutable or quiescent artifact trees. Store the reports outside those trees.

```sh
python skills/production-delta-release/scripts/inventory.py snapshot baseline-artifact --output baseline.json
python skills/production-delta-release/scripts/inventory.py snapshot candidate-artifact --output candidate.json
python skills/production-delta-release/scripts/inventory.py compare baseline.json candidate.json --manifest approved-delta.json --output comparison.json
```

Create `approved-delta.json` from the reviewed change specification. Copy exact SHA-256 values from independently reviewed baseline and candidate artifacts. Approving every observed difference automatically would remove the scope check.

```json
{
  "schemaVersion": 1,
  "changes": [
    {
      "path": "dist/changed-module.js",
      "before": "REPLACE_WITH_64_CHARACTER_BASELINE_SHA256",
      "after": "REPLACE_WITH_64_CHARACTER_CANDIDATE_SHA256"
    }
  ]
}
```

Use `null` as `before` for an addition and as `after` for a removal. The placeholders intentionally fail validation. The demo provides a fully runnable example with genuine generated digests.

Comparison exits 0 for an exact match, 1 for an unapproved, missing or mismatched change and 2 for an invalid input or output error. A JSON report lists paths and hashes are checked internally. Snapshot reports contain paths, sizes and hashes, so treat filenames as potentially private. Existing output files are preserved. Choose a new report name for another run.

The collector preserves case and Unicode in paths. It rejects symlinks and special filesystem entries. An image-aware collector must explicitly represent symlink targets, file permissions, owners and image configuration when those properties matter. The helper covers regular-file content and size, so provide those additional checks in your deployment adapter.

## Example request to an AI agent

> Read `skills/production-delta-release/SKILL.md`. Prepare a release plan for this reviewed patch against the deployed image digest. The checkout contains unrelated work. Capture the candidate delta, identify missing provenance and prepare activation and recovery checks. Stop before deployment until the user-authorized release conditions are satisfied.
