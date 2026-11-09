"""Offline regular-file inventory and exact delta verification."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def valid_path(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ValueError('Inventory paths must be relative POSIX paths')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/')):
        raise ValueError('Inventory path escapes its root or is ambiguous')
    if any(ord(char) < 32 for char in value):
        raise ValueError('Control characters are unsupported in inventory paths')
    return value


def valid_hash(value, nullable=False):
    if nullable and value is None:
        return value
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None:
        raise ValueError('Expected lowercase SHA-256')
    return value


def snapshot(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Snapshot root must be a regular directory')
    files = []
    for folder, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            if (Path(folder) / name).is_symlink():
                raise ValueError('Symlink encountered; use an explicit image inventory adapter')
        for name in names:
            path = Path(folder) / name
            if not path.is_file():
                raise ValueError('Unsupported filesystem entry')
            before = path.stat()
            value = digest(path)
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError('File changed during inventory')
            files.append({'path': valid_path(path.relative_to(root).as_posix()),
                          'sha256': value, 'size': after.st_size})
    return {'schemaVersion': 1, 'files': sorted(files, key=lambda item: item['path'])}


def read_json(path):
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('Manifest exceeds 32 MiB')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def file_map(document):
    if not isinstance(document, dict) or document.get('schemaVersion') != 1 or not isinstance(document.get('files'), list):
        raise ValueError('Expected inventory schemaVersion 1 with files')
    result = {}
    for row in document['files']:
        if not isinstance(row, dict):
            raise ValueError('Inventory entries must be objects')
        path = valid_path(row['path'])
        if path in result:
            raise ValueError('Duplicate inventory path')
        if type(row.get('size')) is not int or row['size'] < 0:
            raise ValueError('Invalid file size')
        result[path] = (valid_hash(row['sha256']), row['size'])
    return result


def compare(baseline, candidate, manifest):
    old, new = file_map(baseline), file_map(candidate)
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('changes'), list):
        raise ValueError('Expected delta schemaVersion 1 with changes')
    approved = {}
    for row in manifest['changes']:
        if not isinstance(row, dict):
            raise ValueError('Delta entries must be objects')
        path = valid_path(row['path'])
        if path in approved:
            raise ValueError('Duplicate approved change')
        before = valid_hash(row['before'], nullable=True)
        after = valid_hash(row['after'], nullable=True)
        if before == after:
            raise ValueError('A delta must change a file')
        approved[path] = (before, after)
    actual = {path for path in old.keys() | new.keys() if old.get(path) != new.get(path)}
    expected = set(approved)
    mismatched = []
    for path in actual & expected:
        pair = (old[path][0] if path in old else None, new[path][0] if path in new else None)
        if pair != approved[path]:
            mismatched.append(path)
    return {'passed': actual == expected and not mismatched,
            'unexpected': sorted(actual - expected), 'missing': sorted(expected - actual),
            'hashMismatch': sorted(mismatched), 'changed': sorted(actual),
            'baselineFiles': len(old), 'candidateFiles': len(new)}


def save_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive destination creation preserves earlier receipts on reruns.
    with path.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    capture = modes.add_parser('snapshot')
    capture.add_argument('root', type=Path)
    capture.add_argument('--output', type=Path, required=True)
    verify = modes.add_parser('compare')
    verify.add_argument('baseline', type=Path)
    verify.add_argument('candidate', type=Path)
    verify.add_argument('--manifest', type=Path, required=True)
    verify.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.mode == 'snapshot':
            if args.output.resolve().is_relative_to(args.root.resolve()):
                raise ValueError('Write inventory outside the captured directory')
            value = snapshot(args.root)
        else:
            value = compare(read_json(args.baseline), read_json(args.candidate), read_json(args.manifest))
        save_new(args.output, value)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f'Inventory error: {error}\n')
    print(json.dumps({'output': str(args.output), 'passed': value.get('passed', True)}))
    return 0 if value.get('passed', True) else 1


if __name__ == '__main__':
    raise SystemExit(main())
