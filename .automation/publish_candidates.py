"""Publish only the two reviewed frontend candidates, after workflow gates.

This helper belongs to an isolated automation branch, never a product PR.
No merge, reset, stash, forced push, deployment or personal secrets.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

BASE = '7c0cb5b60243e135bbc172b1b924eed4e61dd783'
PAYLOAD_SHA256 = '0a522dd30757351271070bf8516d325821674245b7d496041342f55f5ed13b2e'
REPOSITORY = 'bairasbai/tili-tili'
AUTOMATION_REF = 'refs/heads/automation/publish-candidates-20261005'


def run(repo: Path, *args: str) -> str:
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'git {args[0]} failed: {result.stderr.strip()}')
    return result.stdout


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def target(feature: str) -> str:
    if feature not in ('wp09', 'wp02'):
        raise ValueError('Only wp09 and wp02 are allowed')
    return f'candidate/tili-{feature}-20261005'


def remote(repo: Path, branch: str) -> str | None:
    output = run(repo, 'ls-remote', '--refs', 'origin', f'refs/heads/{branch}').strip()
    if not output:
        return None
    lines = output.splitlines()
    if len(lines) != 1 or lines[0].split()[1] != f'refs/heads/{branch}':
        raise RuntimeError('Unexpected remote ref response')
    return lines[0].split()[0]


def paths(feature: str):
    target(feature)
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY or os.environ.get('GITHUB_REF') != AUTOMATION_REF:
        raise RuntimeError('Wrong repository or automation branch')
    workspace = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    repo = workspace / 'source'
    package = Path(os.environ['RUNNER_TEMP']) / f'candidate-package-{feature}'
    evidence = Path(os.environ['EVIDENCE_DIR'])
    evidence.mkdir(parents=True, exist_ok=True)
    return workspace, repo, package, evidence


def apply(feature: str) -> None:
    workspace, repo, package, evidence = paths(feature)
    payload = b''.join((workspace / f'delivery/.automation/payload-{index}.xzpart').read_bytes() for index in range(4))
    if hashlib.sha256(payload).hexdigest() != PAYLOAD_SHA256:
        raise RuntimeError('Payload checksum mismatch')
    package.mkdir(exist_ok=False)
    contents = json.loads(lzma.decompress(payload))
    if len(contents) != 14:
        raise RuntimeError('Unexpected payload inventory')
    for name, content in contents.items():
        relative = PurePosixPath(name)
        if not name or relative.is_absolute() or '..' in relative.parts or '\\' in name:
            raise RuntimeError('Unsafe package path')
        path = package.joinpath(*relative.parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8', newline='\n')
    spec = importlib.util.spec_from_file_location('candidate_prepare', package / 'prepare.py')
    if spec is None or spec.loader is None:
        raise RuntimeError('Cannot load preparation tool')
    prepare = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prepare)
    original, changed, step = prepare.preflight(repo, feature)
    if remote(repo, 'main') != BASE:
        raise RuntimeError('Main advanced; reconcile rather than apply stale source')
    if remote(repo, target(feature)) is not None:
        raise RuntimeError('Candidate branch already exists; do not overwrite')
    subprocess.run([sys.executable, str(package / 'prepare.py'), '--repo', str(repo),
                    '--feature', feature, '--apply'], check=True)
    manifest = {name: digest(repo / name) for name in sorted(changed)}
    if not manifest or any(name.startswith(('.github/', '.automation/')) for name in manifest):
        raise RuntimeError('Unexpected product paths')
    (evidence / 'input.json').write_text(json.dumps({
        'base': BASE, 'feature': feature, 'branch': target(feature),
        'message': step['message'], 'files': manifest, 'payload_sha256': PAYLOAD_SHA256,
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (evidence / 'candidate.patch').write_text(prepare.patch_text(original, changed), encoding='utf-8')
    print(f'Prepared {feature}: {len(manifest)} paths; no remote product writes yet')


def publish(feature: str) -> None:
    _, repo, _, evidence = paths(feature)
    info = json.loads((evidence / 'input.json').read_text())
    branch = target(feature)
    if info['base'] != BASE or info['branch'] != branch or info['feature'] != feature:
        raise RuntimeError('Manifest scope mismatch')
    if run(repo, 'branch', '--show-current').strip() != branch or run(repo, 'rev-parse', 'HEAD').strip() != BASE:
        raise RuntimeError('Local candidate ref moved before publication')
    for name, expected in info['files'].items():
        if digest(repo / name) != expected:
            raise RuntimeError(f'Tested input changed: {name}')
    tracked = set(filter(None, run(repo, 'diff', '--name-only', '-z').split('\0')))
    if not tracked.issubset(info['files']):
        raise RuntimeError(f'Unrelated tracked changes: {sorted(tracked - set(info["files"]))}')
    if run(repo, 'diff', '--cached', '--name-only').strip():
        raise RuntimeError('Unexpected staged files')
    log_names = ('frontend-types.log', 'frontend-tests.log', 'frontend-lint.log', 'frontend-build.log')
    if any(not (evidence / name).is_file() for name in log_names):
        raise RuntimeError('Missing gate evidence')
    # Only reached by the workflow after all four gates exit successfully.
    report = repo / f'tasks/wedding-platform-master-plan/CANDIDATE-{feature.upper()}-20261005.md'
    workflow_url = f'https://github.com/{REPOSITORY}/actions/runs/{os.environ["GITHUB_RUN_ID"]}'
    with report.open('a', encoding='utf-8') as out:
        out.write('\n\n## Publication gate, 2026-10-05\n\n'
                  f'Workflow: {workflow_url}, attempt {os.environ["GITHUB_RUN_ATTEMPT"]}. '
                  'The full checkout frontend TypeScript, complete Vitest suite, ESLint and production build passed '
                  'before this candidate commit was created. The immutable pre-gate file manifest and logs are workflow artifacts. '
                  'Earlier UNRUN statements above describe preparation history. '
                  'Backend/PostgreSQL/Redis, real browser/mobile acceptance and exact-head PR CI are still unverified by this helper. '
                  'This remains a candidate, not whole-WP acceptance. No main merge, auto-merge or deployment.\n')
    expected_paths = sorted(info['files'])
    run(repo, 'add', '--', *expected_paths)
    staged = set(filter(None, run(repo, 'diff', '--cached', '--name-only', '-z').split('\0')))
    if staged != set(expected_paths):
        raise RuntimeError('Staged inventory mismatch')
    run(repo, 'diff', '--cached', '--check')
    run(repo, 'config', 'user.name', 'github-actions[bot]')
    run(repo, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    run(repo, 'commit', '-m', info['message'], '-m',
        'Frontend gates verified in ' + workflow_url + '. Candidate only; full PR CI and browser acceptance pending. Do not auto-merge.')
    sha = run(repo, 'rev-parse', 'HEAD').strip()
    if remote(repo, 'main') != BASE or remote(repo, branch) is not None:
        raise RuntimeError('Remote changed; publication stopped without force')
    # An explicit literal candidate destination; no main, wildcard or force push.
    run(repo, 'push', 'origin', f'HEAD:refs/heads/{branch}')
    if remote(repo, branch) != sha:
        raise RuntimeError('Remote publication readback mismatch')
    info.update({'commit': sha, 'tree': run(repo, 'rev-parse', 'HEAD^{tree}').strip(),
                 'workflow_url': workflow_url,
                 'published_files': {name: digest(repo / name) for name in expected_paths},
                 'gate_logs': {name: digest(evidence / name) for name in log_names},
                 'main_after': remote(repo, 'main'), 'merged': False})
    (evidence / 'publication.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(info, ensure_ascii=False, indent=2))
    with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a') as out:
        out.write(f'## {feature}\n\nPublished candidate `{sha}` on `{branch}`. '
                  'Frontend gates passed. Full PR CI and browser acceptance pending. No merge.\n')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('apply', 'publish'):
        raise SystemExit('Usage: publish_candidates.py apply|publish wp09|wp02')
    {'apply': apply, 'publish': publish}[sys.argv[1]](sys.argv[2])
