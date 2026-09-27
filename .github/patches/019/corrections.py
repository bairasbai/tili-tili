from pathlib import Path
import json
r = Path('Тили-тили/backend')
for name in ['offers019.test.ts', 'shortlist019.test.ts']:
    p = r / 'test' / name
    s = p.read_text()
    assert 'expect(consent.statusCode, consent.body).toBe(200)' in s
    p.write_text(s.replace('expect(consent.statusCode, consent.body).toBe(200)', 'expect(consent.statusCode, consent.body).toBe(201)'))
p = r / 'vitest.serial.json'
a = json.loads(p.read_text())
a = sorted(set(a + ['test/audit12.test.ts', 'test/shortlist019.test.ts']))
p.write_text(json.dumps(a, indent=2) + '\n')
p = r / 'test/accept019.test.ts'
s = p.read_text().replace('const accepting = accept(f.w, f.offer.id)', 'const accepting = accept(f.w, f.offer.id).then(result => result)')
p.write_text(s)
