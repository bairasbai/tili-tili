import { describe, expect, it } from 'vitest'
import { routeSources } from './routeSource.js'

describe('source route scope and actual local helper calls', () => {
  it('expands literal suffix tables and resolves only the helper actually called by each route', () => {
    const routes = routeSources(`function register(app) {
      function mutate(request) { readKeyHeader(request, true) }
      for (const [suffix, action] of [['', first], ['/replace', second]] as const) {
        app.post(\`/deals/:dealId/order/resource-commitments\${suffix}\`, request => mutate(request, action))
        { const suffix = '/inner'; app.get(suffix, request => request) }
      }
      app.get('/unrelated', request => request)
      app.post(\`/unknown/\${runtimeValue}\`, request => mutate(request))
    }`)
    expect(routes.map(r => [r.method, r.path])).toEqual([
      ['post', '/deals/:dealId/order/resource-commitments'],
      ['get', '/inner'], ['post', '/deals/:dealId/order/resource-commitments/replace'],
      ['get', '/inner'], ['get', '/unrelated'],
    ])
    expect(routes[0]!.text).toContain('readKeyHeader(request, true)')
    expect(routes[2]!.text).toContain('readKeyHeader(request, true)')
    expect(routes[1]!.text).not.toContain('readKeyHeader')
    expect(routes[3]!.text).not.toContain('readKeyHeader')
    expect(routes[4]!.text).not.toContain('readKeyHeader')
  })
  it('resolves prefixed writes through nested helpers without attributing an unrelated helper to GET', () => {
    const routes = routeSources(`async function register(app) {
      const root = '/vendors/:vendorId'
      app.get(root + '/resources', request => read(request))
      function read(request) { return [] }
      function mutate(request) { return claim(request) }
      function claim(request) { readKeyHeader(request, true); throw new AppError(409, 'fixture_conflict') }
      app.patch(root + '/availability-policy', request => mutate(request))
    }`)
    expect(routes.map(r => [r.method, r.path])).toEqual([['get', '/vendors/:vendorId/resources'], ['patch', '/vendors/:vendorId/availability-policy']])
    expect(routes[0]!.text).not.toContain('AppError(409')
    expect(routes[0]!.text).not.toContain('readKeyHeader')
    expect(routes[1]!.text).toContain('readKeyHeader(request, true)')
    expect(routes[1]!.text).toContain('AppError(409')
  })
  it('keeps lexical prefix/helper bindings distinct and ignores registrations inside comments', () => {
    const routes = routeSources(`
      function first(app) { const root='/one'; function mutate(request) { readKeyHeader(request, true) }; app.post(root, request=>mutate(request)) }
      function second(app) { const root='/two'; function mutate(request) { return request }; app.post(root, request=>mutate(request)) }
      // app.post('/imaginary', request => readKeyHeader(request, true))
    `)
    expect(routes.map(r => r.path)).toEqual(['/one', '/two'])
    expect(routes[0]!.text).toContain('readKeyHeader')
    expect(routes[1]!.text).not.toContain('readKeyHeader')
  })
})
