"""Run the repository's offline tests with the current Python and Node runtimes."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(arguments):
    print('+ ' + ' '.join(arguments), flush=True)
    subprocess.run(arguments, cwd=ROOT, check=True, timeout=180)


def main():
    run([sys.executable, '-B', 'scripts/check_skills.py'])
    for name in ['pdf-rag-source-repair', 'production-delta-release']:
        run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', f'skills/{name}/tests', '-v'])
    run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'])
    for name in ['safe-llm-failover', 'verified-apk-release']:
        tests = sorted((ROOT / 'skills' / name).rglob('*.test.mjs'))
        if not tests:
            raise RuntimeError(f'No behavioral tests found for {name}')
        run(['node', '--test', *[str(path) for path in tests]])
    run([sys.executable, '-B', 'skills/production-delta-release/scripts/demo_release.py'])


if __name__ == '__main__':
    main()
