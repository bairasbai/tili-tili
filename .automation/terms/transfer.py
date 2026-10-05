"""Transfer reviewed frontend/docs blobs only; never change product refs or run code."""
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import urllib.request

HERE = Path(__file__).resolve().parent
ALLOWED = {
    'JOURNAL.md', 'session-handoff.md', 'tasks/todo.md',
    'tasks/wedding-platform-master-plan/WP09-ORDER-TERMS-20261006.md',
    'Тили-тили/app/src/components/WeeklyOrderTerms.tsx',
    'Тили-тили/app/src/lib/api/weeklyOrderTerms.ts',
    'Тили-тили/app/src/lib/i18n.en.orders.ts',
    'Тили-тили/app/src/lib/weeklyOrderTerms.test.ts',
    'Тили-тили/app/src/lib/weeklyOrderTerms.test.tsx',
    'Тили-тили/app/src/lib/weeklyOrderTerms.ts',
    'Тили-тили/app/src/pages/WeeklyAgenda.tsx',
    'Тили-тили/Тили-тили_Карта_кнопок.md',
    'Тили-тили/Тили-тили_Карта_экранов.md',
}

def git(*args):
    return subprocess.check_output(['git', *args]).decode('utf-8').strip()

def main():
    manifest = json.loads((HERE / 'manifest.json').read_text())
    assert manifest['base'] == '4c41e4abceba1750fa3cc388455397c93782fe7f'
    assert manifest['base_tree'] == 'b992e2d3a5bb51e07abf7ab83afc6fd31adf7d11'
    assert manifest['expected_tree'] == '164cd7600a8ccc15e012842ae61d76a118a600fa'
    assert manifest['patch_sha256'] == 'b078d2ac16e6693625b426155fdc1dddd992daf5e3aa469cbc9933a0ef5bd24a'
    assert len(manifest['entries']) == len(ALLOWED)
    assert {entry['path'] for entry in manifest['entries']} == ALLOWED
    assert git('rev-parse', 'HEAD') == manifest['base']
    assert git('rev-parse', 'HEAD^{tree}') == manifest['base_tree']
    assert not git('status', '--porcelain')
    encoded = ''.join((HERE / f'part-{i}.b64').read_text().strip() for i in range(4))
    assert len(encoded) == 22172
    with gzip.GzipFile(fileobj=io.BytesIO(base64.b64decode(encoded, validate=True))) as stream:
        patch = stream.read(200001)
    assert len(patch) == 58225
    assert hashlib.sha256(patch).hexdigest() == manifest['patch_sha256']
    patch_path = HERE / 'reviewed.patch'
    patch_path.write_bytes(patch)
    subprocess.run(['git', 'apply', '--check', str(patch_path)], check=True)
    subprocess.run(['git', 'apply', str(patch_path)], check=True)
    subprocess.run(['git', 'add', '--', *sorted(ALLOWED)], check=True)
    names = subprocess.check_output(['git', 'diff', '--cached', '--name-only', '-z']).decode().split('\0')
    assert set(filter(None, names)) == ALLOWED
    assert not git('diff', '--name-only')
    assert not git('ls-files', '--others', '--exclude-standard')
    subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
    assert git('write-tree') == manifest['expected_tree']
    for entry in manifest['entries']:
        path = Path(entry['path'])
        assert path.is_file() and not path.is_symlink()
        assert entry['mode'] == '100644' and entry['type'] == 'blob'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']
        assert git('hash-object', '--', str(path)) == entry['sha']
    assert os.environ['GITHUB_REPOSITORY'] == 'bairasbai/tili-tili'
    endpoint = 'https://api.github.com/repos/bairasbai/tili-tili/git/blobs'
    result = {k: manifest[k] for k in ('base', 'base_tree', 'expected_tree', 'patch_sha256')}
    result['uploaded'] = []
    output = HERE / 'result'
    output.mkdir(exist_ok=True)
    for entry in manifest['entries']:
        body = json.dumps({'encoding': 'base64', 'content': base64.b64encode(Path(entry['path']).read_bytes()).decode()}).encode()
        request = urllib.request.Request(endpoint, data=body, method='POST', headers={
            'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'tili-terms-reviewed-blob-transfer',
        })
        with urllib.request.urlopen(request, timeout=60) as response:
            uploaded = json.load(response)
        assert uploaded['sha'] == entry['sha']
        result['uploaded'].append(entry)
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'uploaded_blobs': len(result['uploaded']), 'checked_tree': manifest['expected_tree'], 'refs_changed': False}))

if __name__ == '__main__':
    main()
