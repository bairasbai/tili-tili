import hashlib, json, os, pathlib, subprocess, sys, urllib.request

def git(*args):
    return subprocess.check_output(['git', '-c', 'core.quotePath=false', *args]).decode().strip()
base = '788ff31373e23d60a9321e5815fc04f37fc6ae93'
tree = '86543d899afa39681ceb06f1f165f77b804b6666'
patch_hash = 'fa8943c45b925346fb7255311710185d82791c41f5422859efd648cbde11e21b'
expected = {
  'Тили-тили/backend/scripts/ecosystem-migration-drill.mjs': 'd3abcd12a063aa1cc209cf71bde6c6bdae7e3dbb',
  'Тили-тили/backend/test/migrationDrillImports.test.ts': '27e1fb1846efdd791a3829260c828a8c7d9cca91',
  'tasks/wedding-platform-master-plan/FR005-DRILL-IMPORT-REPAIR-20261006.md': '86fea153d23386c6fa394de687a0089d2ae0f6a9',
  'JOURNAL.md': '5b99a6af818e49f25dc96367b3e5fb0a3d8c4105',
  'ERRORS.md': '71aeb6107ee570bbe6ee79e2ae57bb4610e92048',
  'session-handoff.md': '51aeea1fc17895ab93ea118aa491a3e25b3984b4',
  'tasks/todo.md': '530738178ae17ddb4fb4db8eaf795c4cd4a63f71',
}
assert git('rev-parse', 'HEAD') == base
assert git('rev-parse', 'HEAD^{tree}') == '5e6dcfe3393dbc742bc8e28faf4889b2883c89a1'
assert not git('status', '--porcelain')
patch = pathlib.Path(os.environ['RUNNER_TEMP']) / 'imports-repair.patch'
assert hashlib.sha256(patch.read_bytes()).hexdigest() == patch_hash
subprocess.run(['git', 'apply', '--check', '--index', '--unidiff-zero', str(patch)], check=True)
subprocess.run(['git', 'apply', '--index', '--unidiff-zero', str(patch)], check=True)
assert set(git('diff', '--cached', '--name-only').splitlines()) == set(expected)
assert git('write-tree') == tree
for path, sha in expected.items():
    assert git('rev-parse', ':' + path) == sha
    assert git('hash-object', path) == sha
if sys.argv[1:] == ['--upload']:
    for path, sha in expected.items():
        body = json.dumps({'content': pathlib.Path(path).read_text(), 'encoding': 'utf-8'}).encode()
        request = urllib.request.Request('https://api.github.com/repos/bairasbai/tili-tili/git/blobs', data=body, method='POST', headers={
            'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=45) as response:
            assert json.load(response)['sha'] == sha
else:
    assert not sys.argv[1:]
out = pathlib.Path(os.environ['RUNNER_TEMP']) / 'imports-proof'; out.mkdir(exist_ok=True)
(out / 'verified.json').write_text(json.dumps({'base': base, 'tree': tree, 'patchSha256': patch_hash, 'files': expected}, ensure_ascii=False, indent=2))
print('Verified exact seven-file repair; no product refs changed.')
