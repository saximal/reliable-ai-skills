"""Copy selected skills into an explicitly chosen client discovery directory."""
import argparse
from pathlib import Path
import shutil
import tempfile

REPOSITORY = Path(__file__).resolve().parents[1]


def install(target, names, dry_run=False):
    source = REPOSITORY / 'skills'
    target = target.expanduser().resolve()
    if target == REPOSITORY or target.is_relative_to(REPOSITORY):
        raise ValueError('Choose a client discovery directory outside this repository')
    paths = []
    for name in dict.fromkeys(names):
        package = source / name
        if package.parent != source or package.is_symlink() or not (package / 'SKILL.md').is_file():
            raise ValueError('Unknown skill name')
        if (target / name).exists() or (target / name).is_symlink():
            raise FileExistsError(f'Installed skill already exists: {name}')
        if any(path.is_symlink() for path in package.rglob('*')):
            raise ValueError('Skill contains a symlink')
        paths.append((package, target / name))
    if dry_run:
        return [str(destination) for _, destination in paths]
    target.mkdir(parents=True, exist_ok=True)
    for package, destination in paths:
        staging = Path(tempfile.mkdtemp(prefix='.skill-install-', dir=target))
        staged_skill = staging / package.name
        shutil.copytree(package, staged_skill, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(f'Installed skill appeared during copying: {package.name}')
        staged_skill.rename(destination)
        staging.rmdir()
    return [str(destination) for _, destination in paths]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--skill', action='append', choices=sorted(
        path.name for path in (REPOSITORY / 'skills').iterdir() if (path / 'SKILL.md').is_file()))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    names = args.skill or sorted(path.name for path in (REPOSITORY / 'skills').iterdir()
                                 if (path / 'SKILL.md').is_file())
    try:
        destinations = install(args.target, names, args.dry_run)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Installation failed: {error}\n')
    for destination in destinations:
        print(('Would install ' if args.dry_run else 'Installed ') + destination)


if __name__ == '__main__':
    main()
