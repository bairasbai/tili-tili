from pathlib import Path
import json,re
r = Path('Тили-тили/backend')
for name in ['offers019.test.ts', 'shortlist019.test.ts']:
    p = r / 'test' / name
    s = p.read_text()
    assert 'expect(consent.statusCode, consent.body).toBe(200)' in s
    p.write_text(s.replace('expect(consent.statusCode, consent.body).toBe(200)', 'expect(consent.statusCode, consent.body).toBe(201)'))
p = r / 'vitest.serial.json'
a = json.loads(p.read_text())
a = sorted((set(a) - {'test/accept019.test.ts','test/offers019.test.ts','test/shortlist019.test.ts'}) | {'test/audit12.test.ts'})
p.write_text(json.dumps(a, indent=2) + '\n')
p = r / 'test/accept019.test.ts'
s = p.read_text().replace('const accepting = accept(f.w, f.offer.id)', 'const accepting = accept(f.w, f.offer.id).then(result => result)')
s = s.replace('otpMaxPerIpHour: 1_000_000,', '// Test fixture throughput only; production rate limits remain unchanged.\n      rateLimitPerSecond: 1_000_000,\n      otpMaxPerIpHour: 1_000_000,')
s = s.replace('    const phone = nextPhone()\n', '    const phone = nextPhone()\n    const remoteAddress = `2001:db8:${Number(RUN).toString(16).slice(-4)}:${counter.toString(16)}::1`\n')
s = s.replace('remoteAddress: IP', 'remoteAddress')
s = s.replace("  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`\n", '')
s = s.replace("      url: '/auth/otp/verify',", "      url: '/auth/otp/verify',\n      remoteAddress,")
s = s.replace('expect(badBody.statusCode, badBody.body).toBe(400)', 'expect(badBody.statusCode, badBody.body).toBe(422)')
s = s.replace('    const deletion = app.db!.tx(async client => {', '    let blockerPid = 0\n    const deletion = app.db!.tx(async client => {\n      const { rows: pids } = await client.query<{ pid: number }>(\'select pg_backend_pid() as pid\')\n      blockerPid = pids[0]!.pid')
s = s.replace('and cardinality(pg_blocking_pids(pid)) > 0) as waiting`)', 'and $1 = ANY(pg_blocking_pids(pid))) as waiting`, [blockerPid])')
p.write_text(s)
# Previously skipped US2 fixtures exceeded the API's five-year wedding window.
p = r / 'test/offers019.test.ts'
s = p.read_text().replace('const live = Boolean(DB)', 'const live = Boolean(DB)\nconst YEAR = new Date().getUTCFullYear() + 2')
s = re.sub(r"'2034-(\d\d-\d\d)'", r'`${YEAR}-\1`', s)
s = re.sub(r"'2035-(\d\d-\d\d)'", r'`${YEAR + 1}-\1`', s)
p.write_text(s)
# Aggregate OTP reads also depend on shared state; keep the guard strict.
p = r / 'test/audit53.test.ts'
s = p.read_text()
needle = "  if (code.includes('/admin/categories')) return true"
assert needle in s
s = s.replace(needle, '''  // A global OTP budget can shrink when another suite cleans up its phones.
  // Scoped counts (phone/IP predicates) remain safe to run in parallel.
  for (const literal of stringLiterals(code)) {
    if (/\\bselect\\s+count\\s*\\([^)]*\\)[\\s\\S]*\\bfrom\\s+otp_codes\\b/i.test(literal)
      && !/\\b(?:phone|ip)\\b\\s*(?:=|like\\b|in\\b)/i.test(literal)) return true
  }
''' + needle)
s += '''\n\ndescribe('serial guard: aggregate OTP budget', () => {
  it('requires serialization only for a global counter, not a fixture-scoped count', () => {
    expect(touchesSharedState(`client.query("select count(*) from otp_codes where created_at > now() - interval '1 hour'")`)).toBe(true)
    expect(touchesSharedState(`client.query('select count(*) from otp_codes where phone = $1')`)).toBe(false)
    expect(touchesSharedState(`client.query('select count(*) from otp_codes where phone like $1')`)).toBe(false)
    expect(touchesSharedState(`client.query('select count(*) from otp_codes where ip = $1')`)).toBe(false)
  })
})
'''
p.write_text(s)
p = Path('Тили-тили/Тили-тили_API_openapi.yaml')
s = p.read_text().replace('Требуется Idempotency-Key, ключ слишком длинный или передано тело', 'Требуется Idempotency-Key или ключ слишком длинный')
a,b = s.index('  /weddings/{weddingId}/offers/{offerId}/accept:'),s.index('  /weddings/{weddingId}/slots/{slotId}/offer-requests:')
chunk = s[a:b] + "        '422':\n          description: Передано тело запроса; условия берутся только из предложения\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/Error' }\n"
p.write_text(s[:a]+chunk+s[b:])
p = Path('Тили-тили/app/src/lib/i18n.en.ts')
s = p.read_text()
s = re.sub(r'^  "([^"\n]+)": "([^"\n]+)",$', lambda m: '  '+repr(m[1])+': '+repr(m[2])+',', s, flags=re.M)
p.write_text(s)
p = Path('Тили-тили/app/src/lib/offers019.test.tsx')
s = p.read_text()
a = "    expect(view.calls.filter(c => c.path === '/weddings/w1/slots' && c.method === 'GET').length).toBeGreaterThan(1)"
assert a in s
s = s.replace(a, "    await waitFor(() => expect(view.calls.filter(c => c.path === '/weddings/w1/slots' && c.method === 'GET').length).toBeGreaterThan(1))")
p.write_text(s)
p = Path('tasks/фичи/019-кандидаты-и-предложения/acceptance-report.md')
s = p.read_text().replace('- Новые SQL-тесты включены в serial-проект; US2-тесты с eraseUser также сериализованы.', '- SQL-тесты идут с живыми сервисами; глобальный OTP-счётчик включён в serial-проект.\n  Сторож конфигурации проверяет это правило; scoped фикстуры 019 остаются параллельными.')
p.write_text(s)
