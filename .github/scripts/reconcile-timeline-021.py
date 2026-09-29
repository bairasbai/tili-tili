"""Stage the reviewed main merge in an isolated CI checkout; never push refs."""
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
MAIN = 'ccd68fdcaa5a433c5892469ab5c4c552999901d7'
GENERATED = [
    'Тили-тили/backend/src/contract/paths.generated.ts',
    'Тили-тили/backend/src/contract/schemas.generated.ts',
]
AUDIT = 'Тили-тили/backend/test/audit55.test.ts'


def git(*args, check=True):
    return subprocess.run(['git', *args], cwd=ROOT, check=check, capture_output=True, text=True)


def replace_once(text, old, new):
    assert text.count(old) == 1, 'Expected one reviewed source marker: ' + old[:80]
    return text.replace(old, new)


git('fetch', '--no-tags', 'origin', 'refs/heads/main')
actual = git('rev-parse', 'FETCH_HEAD').stdout.strip()
assert actual == MAIN, 'Main changed; review before merging: ' + actual
git('config', 'user.name', 'Timeline integration verifier')
git('config', 'user.email', 'verification@localhost')
merged = git('merge', '--no-commit', '--no-ff', MAIN, check=False)
print(merged.stdout)
assert merged.returncode in (0, 1), 'Merge failed unexpectedly'
conflicts = set(filter(None, git('diff', '--name-only', '--diff-filter=U', '-z').stdout.split('\0')))
assert conflicts <= set(GENERATED + [AUDIT]), 'Unexpected conflicts: ' + repr(conflicts)
for name in GENERATED:
    if name in conflicts:
        git('checkout', '--ours', '--', name)
        git('add', '--', name)
path = ROOT / AUDIT
text = path.read_text()
pattern = r'(?ms)^<<<<<<< HEAD\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]+\n'
blocks = list(re.finditer(pattern, text))
assert len(blocks) == 1 and all('версия контракта' in b.group(1) and 'версия контракта' in b.group(2) for b in blocks)
text = re.sub(pattern, "  it('версия контракта — 0.53.0 (021 timeline + payment privacy поверх 018/020)', () => {\n", text)
text = replace_once(text, ".toBe('0.52.0')", ".toBe('0.53.0')")
path.write_text(text)
contract = ROOT / 'Тили-тили/Тили-тили_API_openapi.yaml'
contract.write_text(replace_once(contract.read_text(), '  version: 0.52.0', '  version: 0.53.0'))
drill = ROOT / 'Тили-тили/backend/scripts/payment-privacy-migration-rehearsal.mjs'
text = replace_once(drill.read_text(), "migrate(['up'])", "migrate(['up',STAGE])")
text = replace_once(text,
    '// Build the exact pre-021 schema. Apply the normal chain, then use the same\n  // node-pg-migrate down-one semantics as production while the database is empty.',
    '// Build only the payment stage. Later timeline migrations must not change\n  // which migration this payment rollback exercise targets.')
drill.write_text(text)
git('add', '--', AUDIT, str(contract.relative_to(ROOT)), str(drill.relative_to(ROOT)))
assert not git('ls-files', '-u').stdout, 'An unresolved merge remains'
# These files are disjoint from the timeline feature and must stay byte-identical
# to the reviewed main, including ERR-0337 private-payment regression tests.
for name in ('Тили-тили/backend/src/payments/model.ts', 'Тили-тили/backend/src/routes/vendorCabinet.ts',
             'Тили-тили/backend/src/routes/slots.ts', 'Тили-тили/backend/test/paymentSchedule.test.ts'):
    assert (ROOT / name).read_text() == git('show', MAIN + ':' + name).stdout, 'Main privacy delta changed: ' + name
print('Combined source staged locally. Regenerate contracts and run all gates before any publication.')
