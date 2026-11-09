import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='skill-install-test-')
        self.addCleanup(self.temporary.cleanup)
        self.target = Path(self.temporary.name) / 'skills'
        self.skill = 'production-delta-release'

    def test_dry_run_creates_nothing(self):
        paths = installer.install(self.target, [self.skill], dry_run=True)
        self.assertEqual(len(paths), 1)
        self.assertFalse(self.target.exists())

    def test_copy_preserves_entry_point(self):
        installer.install(self.target, [self.skill])
        self.assertEqual((self.target / self.skill / 'SKILL.md').read_bytes(),
                         (ROOT / 'skills' / self.skill / 'SKILL.md').read_bytes())

    def test_existing_skill_preserved(self):
        installer.install(self.target, [self.skill])
        entry = self.target / self.skill / 'SKILL.md'
        entry.write_text('local modifications', encoding='utf8')
        with self.assertRaises(FileExistsError):
            installer.install(self.target, [self.skill])
        self.assertEqual(entry.read_text(), 'local modifications')

    def test_no_partial_copy_when_another_target_exists(self):
        (self.target / 'pdf-rag-source-repair').mkdir(parents=True)
        with self.assertRaises(FileExistsError):
            installer.install(self.target, [self.skill, 'pdf-rag-source-repair'])
        self.assertFalse((self.target / self.skill).exists())

    def test_repo_target_rejected(self):
        with self.assertRaises(ValueError):
            installer.install(ROOT / '.local' / 'installed', [self.skill])

    def test_path_traversal_rejected(self):
        with self.assertRaises(ValueError):
            installer.install(self.target, ['../../elsewhere'])

    def test_duplicate_selection(self):
        self.assertEqual(len(installer.install(self.target, [self.skill, self.skill])), 1)


if __name__ == '__main__':
    unittest.main()
