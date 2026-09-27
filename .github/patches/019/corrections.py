from pathlib import Path
import runpy
runpy.run_path('/tmp/patch019/fixture-fixes.py')
r=Path('Тили-тили')
p=r/'backend/test/accept019.test.ts';s=p.read_text()
old="{ kind: 'offer', packageId: v.packageId } : customOffer(1)"
assert old in s
s=s.replace(old,"{ kind: 'offer', packageId: v.packageId, price: { amount: 12_000_000, currency: 'RUB' }, message: 'Согласованные условия', validUntil: '2028-06-01' } : customOffer(1)")
s=s.replace('    expect(badBody.statusCode, badBody.body).toBe(422)', "    expect(badBody.statusCode, badBody.body).toBe(422)\n    const emptyBody = await app.inject({ method: 'POST', url: path, headers: idem(f.w.token), payload: {} })\n    expect(emptyBody.statusCode, emptyBody.body).toBe(422)")
p.write_text(s)
p=r/'backend/test/offers019.test.ts';s=p.read_text()
for old in ['requestOffers(wedding, slotId, [entryIds[0]!]),','requestOffers(wedding, slotId, [entryIds[1]!]),','answer(vendor, requestId, customOffer(5)),','answer(vendor, requestId, customOffer(6)),']:
    assert old in s
    s=s.replace(old,old[:-1]+'.then(response => response),')
s=s.replace("        `select query from pg_stat_activity\n          where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,", """        `with recursive blocked(pid) as (
           select $1::int
           union
           select a.pid from pg_stat_activity a join blocked b
             on b.pid = any(pg_blocking_pids(a.pid)) where a.pid <> $1
         ) select a.query from pg_stat_activity a join blocked b using (pid)
           where a.pid <> $1 and a.wait_event_type = 'Lock'`,""")
s=s.replace('  /** Успех гонки доказывается фактом ожидания замка, а не таймером (R-316). */', '  /** R-316: actual wait graph, including a second waiter queued behind the first.\n   * inject() is lazy: pending requests below start with .then before probing. */')
p.write_text(s)
p=r/'app/src/lib/api/client.ts';s=p.read_text()
old="  /* PUT и PATCH тоже принимают ключ идемпотентности: контракт требует его,"
assert old in s
s=s.replace(old,"  /** Bodyless POST commands must not silently send {} or a JSON content-type. */\n  postWithoutBody: <P extends PathsWith<'post'>>(path: P, opts?: Options) =>\n    request<Ok<paths[P] extends { post: infer O } ? O : never>>('POST', path as string, undefined, opts),\n"+old)
p.write_text(s)
p=r/'app/src/lib/api/offers.ts';s=p.read_text()
s=s.replace("export const acceptOffer = (weddingId: string, offerId: string, idempotencyKey: string) => api.post(\n", "export const acceptOffer = (weddingId: string, offerId: string, idempotencyKey: string) => api.postWithoutBody(\n")
s=s.replace("  url('/weddings/{weddingId}/offers/{offerId}/accept', { weddingId, offerId }),\n  undefined,", "  url('/weddings/{weddingId}/offers/{offerId}/accept', { weddingId, offerId }),")
p.write_text(s)
p=r/'app/src/lib/offers019.test.tsx';s=p.read_text()
s=s.replace('key: string | null }','key: string | null; contentType: string | null }',1)
s=s.replace("key: headers.get('Idempotency-Key') }", "key: headers.get('Idempotency-Key'), contentType: headers.get('content-type') }")
s=s.replace("[acceptPath]: (call: Call) => { expect(call.body).toBeNull(); expect(call.key).toBeTruthy(); booked = true; return accepted },", "[acceptPath]: () => { booked = true; return accepted },")
old="    expect(view.calls.filter(c => c.method === 'POST' && c.path.endsWith('/accept'))).toHaveLength(1)"
assert old in s
s=s.replace(old,"    const sent = view.calls.filter(c => c.method === 'POST' && c.path.endsWith('/accept'))\n    expect(sent).toHaveLength(1)\n    expect(sent[0]!.body).toBeNull()\n    expect(sent[0]!.contentType).toBeNull()\n    expect(sent[0]!.key).toBeTruthy()",1)
p.write_text(s)
