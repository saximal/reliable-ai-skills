"""Validate skill metadata, local Markdown links and publication hygiene."""
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlparse

try:
    import yaml
except ImportError:
    raise SystemExit('Install validation dependencies with python -m pip install -r requirements-dev.txt')

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ['pdf-rag-source-repair', 'safe-llm-failover', 'verified-apk-release',
          'production-delta-release']


def validate():
    errors = []
    for name in SKILLS:
        path = ROOT / 'skills' / name / 'SKILL.md'
        text = path.read_text(encoding='utf8')
        parts = text.split('---', 2)
        if len(parts) != 3 or parts[0].strip():
            errors.append(f'{name}: missing frontmatter')
            continue
        meta = yaml.safe_load(parts[1])
        if not isinstance(meta, dict) or meta.get('name') != name:
            errors.append(f'{name}: name must match directory')
            continue
        description = meta.get('description')
        if not isinstance(description, str) or not 1 <= len(description) <= 1024:
            errors.append(f'{name}: invalid description')
        if re.search(r'\b(TODO|FIXME)\b', parts[2]):
            errors.append(f'{name}: unfinished scaffold')
        if len(parts[2].splitlines()) > 500:
            errors.append(f'{name}: move extended procedures into references')
    for path in ROOT.rglob('*.md'):
        if any(part in ('.git', '.venv', '.local', 'node_modules') for part in path.relative_to(ROOT).parts):
            continue
        text = path.read_text(encoding='utf8')
        for target in re.findall(r'\]\(([^\s)]+)\)', text):
            target = target.strip('<>')
            parsed = urlparse(target)
            if parsed.scheme or target.startswith('#'):
                continue
            destination = (path.parent / unquote(parsed.path)).resolve()
            if not destination.is_relative_to(ROOT) or not destination.exists():
                errors.append(f'{path.relative_to(ROOT)}: missing local link {target}')
    if errors:
        raise SystemExit('\n'.join(errors))
    print(f'Validated {len(SKILLS)} skill entry points and local Markdown links')


if __name__ == '__main__':
    validate()
