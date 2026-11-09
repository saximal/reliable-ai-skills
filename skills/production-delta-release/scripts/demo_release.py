"""Run a bounded release/rollback example inside a fresh temporary directory."""
import json
from pathlib import Path
import tempfile
from inventory import compare, digest, snapshot


def main():
    with tempfile.TemporaryDirectory(prefix='delta-skill-demo-') as folder:
        root = Path(folder)
        runtime = root / 'service'
        runtime.mkdir()
        target = runtime / 'app.txt'
        target.write_bytes(b'baseline\n')
        before = snapshot(runtime)
        old_bytes = target.read_bytes()
        candidate = b'reviewed patch\n'
        staged = root / 'candidate'
        staged.mkdir()
        (staged / 'app.txt').write_bytes(candidate)
        after = snapshot(staged)
        entry = {'path': 'app.txt', 'before': before['files'][0]['sha256'],
                 'after': after['files'][0]['sha256']}
        result = compare(before, after, {'schemaVersion': 1, 'changes': [entry]})
        if not result['passed']:
            raise RuntimeError('Candidate delta failed')
        if digest(target) != entry['before']:
            raise RuntimeError('Runtime changed before activation')
        target.write_bytes(candidate)
        # A synthetic readiness failure exercises guarded recovery.
        if digest(target) != entry['after']:
            raise RuntimeError('Concurrent change prevents automatic rollback')
        target.write_bytes(old_bytes)
        if snapshot(runtime) != before:
            raise RuntimeError('Baseline was not restored')
        print(json.dumps({'deltaPassed': True, 'simulatedReadinessFailure': True,
                          'rollbackVerified': True, 'environment': 'temporary directory'}))


if __name__ == '__main__':
    main()
