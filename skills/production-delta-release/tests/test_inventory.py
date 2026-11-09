import importlib.util
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

SPEC = importlib.util.spec_from_file_location('inventory', Path(__file__).parents[1] / 'scripts/inventory.py')
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'app.txt').write_text('old', encoding='utf8')
        self.old = inventory.snapshot(self.root)
        (self.root / 'app.txt').write_text('new', encoding='utf8')
        self.new = inventory.snapshot(self.root)
        self.manifest = {'schemaVersion': 1, 'changes': [
            {'path': 'app.txt', 'before': self.old['files'][0]['sha256'],
             'after': self.new['files'][0]['sha256']}]}

    def test_exact_patch(self):
        self.assertTrue(inventory.compare(self.old, self.new, self.manifest)['passed'])

    def test_unapproved_file(self):
        (self.root / 'extra').write_text('unexpected', encoding='utf8')
        result = inventory.compare(self.old, inventory.snapshot(self.root), self.manifest)
        self.assertFalse(result['passed'])
        self.assertEqual(result['unexpected'], ['extra'])

    def test_wrong_baseline(self):
        self.manifest['changes'][0]['before'] = '0' * 64
        self.assertEqual(inventory.compare(self.old, self.new, self.manifest)['hashMismatch'], ['app.txt'])

    def test_missing_change(self):
        self.assertFalse(inventory.compare(self.old, self.old, self.manifest)['passed'])

    def test_added_and_removed_files(self):
        deleted = {'schemaVersion': 1, 'files': []}
        removal = {'schemaVersion': 1, 'changes': [{'path': 'app.txt',
                    'before': self.old['files'][0]['sha256'], 'after': None}]}
        self.assertTrue(inventory.compare(self.old, deleted, removal)['passed'])
        addition = {'schemaVersion': 1, 'changes': [{'path': 'app.txt', 'before': None,
                    'after': self.old['files'][0]['sha256']}]}
        self.assertTrue(inventory.compare(deleted, self.old, addition)['passed'])

    def test_ambiguous_and_escaping_paths(self):
        for path in ['../x', '/x', 'a/../x', 'a//x', 'a\\x', 'C:/x', './x', 'a\nx']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                inventory.valid_path(path)

    def test_duplicate_and_invalid_inventory(self):
        with self.assertRaises(ValueError):
            inventory.file_map({'schemaVersion': 1, 'files': self.old['files'] * 2})
        with self.assertRaises(ValueError):
            inventory.file_map({'schemaVersion': 1, 'files': [{'path': 'a', 'sha256': 'bad', 'size': 1}]})

    def test_receipt_preserved(self):
        output = self.root / 'receipt.json'
        inventory.save_new(output, {'original': True})
        with self.assertRaises(FileExistsError):
            inventory.save_new(output, {'original': False})
        self.assertIn('true', output.read_text())

    def test_non_object_json_has_documented_cli_exit(self):
        invalid = self.root / 'invalid.json'
        invalid.write_text('[]', encoding='utf8')
        command = [sys.executable, str(Path(__file__).parents[1] / 'scripts/inventory.py'),
                   'compare', str(invalid), str(invalid), '--manifest', str(invalid),
                   '--output', str(self.root / 'report.json')]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('Traceback', result.stderr)
        self.assertFalse((self.root / 'report.json').exists())


if __name__ == '__main__':
    unittest.main()
