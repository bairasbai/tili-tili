"""Apply a hash-pinned, text-only delta to an exact isolated checkout."""
import base64
import hashlib
import json
import lzma
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
packed = base64.b64decode(''.join(p.read_text() for p in sorted(pathlib.Path(__file__).parent.glob('*.b64'))), validate=True)
assert hashlib.sha256(packed).hexdigest() == '8eb5e22ed77e18b794ba1e803376dae0a49c3b0a81096d03f54b667ea5806e20'
changes = json.loads(lzma.decompress(packed))
assert len(changes) == 41, len(changes)
for change in changes:
    name = pathlib.PurePosixPath(change['path'])
    assert not name.is_absolute() and '..' not in name.parts and '.git' not in name.parts
    path = root / name
    assert root in path.resolve().parents and not path.is_symlink()
    old = b'' if change['create'] else path.read_bytes()
    if change['create']:
        assert not path.exists(), path
    assert hashlib.sha256(old).hexdigest() == change['old'], name
    lines = old.decode('utf-8').splitlines(keepends=True)
    for start, end, replacement in reversed(change['edits']):
        assert 0 <= start <= end <= len(lines)
        lines[start:end] = replacement
    new = ''.join(lines).encode('utf-8')
    assert hashlib.sha256(new).hexdigest() == change['new'], name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(new)
print(f'Applied {len(changes)} files with base and result SHA-256 verification')
(root.parent / 'manifest019.json').write_text(json.dumps({c['path']: c['new'] for c in changes}))
