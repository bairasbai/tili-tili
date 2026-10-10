import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedOutputOptions, OutputBundle, OutputChunk, PluginContext } from 'rollup'
import type { IndexHtmlTransformContext, Plugin } from 'vite'
import viteConfig from '../../vite.config'
import { CRITICAL_PAGES } from '../../build/criticalAssets'
import { projectFile } from '@/test/projectFiles'

// Only the config's real HTML/worker hooks run here. Importing the Vite/esbuild
// tool runtime into a jsdom realm violates its TextEncoder/Uint8Array invariant.
vi.mock('vite', () => ({ defineConfig: (config: unknown) => config }))
vi.mock('@vitejs/plugin-react', () => ({ default: () => ({ name: 'unit-react' }) }))
vi.mock('kimi-plugin-inspect-react', () => ({ inspectAttr: () => ({ name: 'unit-inspector' }) }))

const sourceHtml = projectFile('index.html')
const entry = 'assets/main-test.js'
const shared = 'assets/react-test.js'
const css = 'assets/main-test.css'
const marker = '/* SHELL_ENTRY_ASSETS */'
const tags = `<script type="module" crossorigin src="./${entry}"></script>
<link rel="modulepreload" crossorigin href="./${shared}">
<link rel="stylesheet" crossorigin href="./${css}">`

function compiledHtml() {
  return sourceHtml.replace(/<script type="module" src="\/src\/main\.tsx"><\/script>/, '')
    .replace('</head>', tags + '\n</head>')
}

function bundle(): OutputBundle {
  const chunk = (name: string, imports: string[] = [], isEntry = false, modules: string[] = []) => ({
    type: 'chunk', fileName: name, isEntry, imports,
    modules: Object.fromEntries(modules.map(id => [id, {}])),
    viteMetadata: { importedCss: new Set(isEntry ? [css] : []) },
  }) as unknown as OutputChunk
  return Object.fromEntries([
    [entry, chunk(entry, [shared], true)], [shared, chunk(shared)],
    [css, { type: 'asset', fileName: css, source: 'body{}' }],
    ...CRITICAL_PAGES.map((page, i) => {
      const file = `assets/page-${i}.js`
      return [file, chunk(file, [shared], false, ['/src/pages/' + page])]
    }),
  ])
}

function configuredPlugins() {
  const options = viteConfig({ command: 'build', mode: 'production' }).plugins as unknown[]
  return options.flat(Infinity).filter(Boolean) as Plugin[]
}

/** With the original config this is the actual unchanged compiled HTML, not a missing import. */
async function transform(html = compiledHtml(), output = bundle()) {
  const plugin = configuredPlugins().find(p => p.name === 'shell-entry-assets')
  const hook = plugin?.transformIndexHtml
  if (!hook) return html
  const handler = typeof hook === 'function' ? hook : hook.handler
  const result = await handler.call({} as PluginContext, html, {
    path: '/index.html', filename: 'index.html', bundle: output,
  } as IndexHtmlTransformContext)
  expect(typeof result).toBe('string')
  return result as string
}

let previousHead: string
let previousURL: string
beforeEach(() => {
  previousHead = document.head.innerHTML
  previousURL = location.href
  sessionStorage.clear()
})
afterEach(() => {
  document.head.innerHTML = previousHead
  history.replaceState(null, '', previousURL)
  sessionStorage.clear()
  vi.restoreAllMocks()
})

function execute(html: string, path: string, blocked = false, ready: DocumentReadyState = 'loading') {
  history.replaceState(null, '', location.origin + path)
  document.head.innerHTML = new DOMParser().parseFromString(html, 'text/html').head.innerHTML
  const script = document.head.querySelector<HTMLScriptElement>('script:not([src])')!
  expect(script).not.toBeNull()
  const writes: string[] = [], replacements: string[] = []
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script)
  vi.spyOn(document, 'readyState', 'get').mockReturnValue(ready)
  vi.spyOn(document, 'write').mockImplementation((...parts: string[]) => { writes.push(parts.join('')) })
  const shellWindow = { location: {
    pathname: location.pathname, search: location.search, hash: location.hash, origin: location.origin,
    replace: (url: string) => replacements.push(url),
  } }
  const storage = { setItem: (key: string, value: string) => {
    if (blocked) throw new DOMException('Storage blocked', 'SecurityError')
    sessionStorage.setItem(key, value)
  } }
  new Function('window', 'document', 'sessionStorage', script.textContent!)(shellWindow, document, storage)
  return { writes, replacements, mounted: new DOMParser().parseFromString(writes.join(''), 'text/html') }
}

describe('compiled shell entry is inert until canonical parser insertion', () => {
  it('removes every active relative entry/preload/style URL from the parser input', async () => {
    const html = await transform()
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect([...parsed.querySelectorAll('script[src],link[rel="modulepreload"],link[rel="stylesheet"]')]).toEqual([])
    expect(html).not.toContain('/src/main.tsx')
  })

  it.each([
    ['/?entry=1#one', '/', false], ['/index.html?entry=1#one', '/', false],
    ['/legal/privacy?lang=en#policy', '/', true], ['/legal/privacy/?lang=ru#policy', '/', true],
    ['/preview/?entry=1#one', '/preview/', false], ['/preview/index.html?entry=1#one', '/preview/', false],
    ['/preview/legal/privacy?lang=en#policy', '/preview/', true], ['/preview/legal/privacy/?lang=ru#policy', '/preview/', true],
  ])('mounts %s without another document or relative assets', async (path, root, deep) => {
    const html = await transform()
    sessionStorage.setItem('tt_redirect', '/prepared/root-target?x=1#keep')
    const before = location.origin + path
    const result = execute(html, path)
    expect(location.href).toBe(before)
    expect(result.replacements).toEqual([])
    expect(result.writes).toHaveLength(1)
    expect(sessionStorage.getItem('tt_redirect')).toBe(deep ? path : '/prepared/root-target?x=1#keep')
    const module = result.mounted.querySelector<HTMLScriptElement>('script[type="module"]')!
    const style = result.mounted.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!
    const preload = result.mounted.querySelector<HTMLLinkElement>('link[rel="modulepreload"]')!
    expect(module.getAttribute('src')).toBe(location.origin + root + entry)
    expect(style.getAttribute('href')).toBe(location.origin + root + css)
    expect(preload.getAttribute('href')).toBe(location.origin + root + shared)
    expect(module.hasAttribute('async')).toBe(false)
    expect(module.getAttribute('crossorigin')).toBe('')
    expect(result.writes[0].indexOf('rel="stylesheet"')).toBeLessThan(result.writes[0].indexOf('type="module"'))
    expect(document.querySelector('base')).toBeNull()
    for (const [rel, file] of [['manifest', 'manifest.webmanifest'], ['icon', 'icon.svg'], ['apple-touch-icon', 'icon-512.png']]) {
      const links = document.head.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`)
      expect(links).toHaveLength(1)
      expect(links[0].getAttribute('href')).toBe(location.origin + root + file)
    }
    history.replaceState(null, '', root + 'wedding/guests?eventId=e&guestId=g#main-rsvp')
    expect(module.getAttribute('src')).toBe(location.origin + root + entry)
    const anchor = document.createElement('a'); anchor.href = '#transfer'
    expect(anchor.href).toBe(new URL('#transfer', location.href).href)
  })

  it('keeps the deep document and canonical assets when storage is blocked', async () => {
    const path = '/preview/legal/privacy/?lang=en#policy'
    const result = execute(await transform(), path, true)
    expect(result.replacements).toEqual([])
    expect(result.writes).toHaveLength(1)
    expect(sessionStorage.getItem('tt_redirect')).toBeNull()
    expect(result.mounted.querySelector('script')!.getAttribute('src')).toBe(location.origin + '/preview/' + entry)
  })

  it.each(['//evil.example/auth', '\\\\evil.example/auth', '/wedding//guests', '/x//evil.example/auth', '/x\\evil.example/auth', '/%2f%2fevil.example/auth'])('cannot activate a foreign-origin resource from %s', async path => {
    const result = execute(await transform(), path)
    expect(result.replacements).toEqual([])
    expect(result.writes).toHaveLength(1)
    for (const node of result.mounted.querySelectorAll('script[src],link[href]')) {
      const url = node.getAttribute('src') ?? node.getAttribute('href')!
      expect(new URL(url).origin).toBe(location.origin)
    }
  })

  it('refuses late execution rather than document.write over a loaded app', async () => {
    const compiled = await transform()
    expect(() => execute(compiled, '/', false, 'complete')).toThrow(/parser/i)
  })
})

describe('compiled asset and injection guards', () => {
  it.each([
    ['missing entry', (h: string) => h.replace(/<script type="module" crossorigin src="[^"]+"><\/script>/, '')],
    ['duplicate entry', (h: string) => h.replace('</head>', tags.split('\n')[0] + '</head>')],
    ['missing stylesheet', (h: string) => h.replace(/<link rel="stylesheet"[^>]+>/, '')],
    ['missing preload', (h: string) => h.replace(/<link rel="modulepreload"[^>]+>/, '')],
    ['duplicate CSS', (h: string) => h.replace('</head>', `<link rel="stylesheet" crossorigin href="./${css}"></head>`)],
    ['foreign URL', (h: string) => h.replace('./' + entry, 'https://evil.example/' + entry)],
    ['relative traversal', (h: string) => h.replace('./' + entry, './assets/../secret.js')],
    ['root absolute URL', (h: string) => h.replace('./' + entry, '/' + entry)],
    ['query URL', (h: string) => h.replace('./' + entry, './' + entry + '?token=x')],
    ['encoded separator', (h: string) => h.replace('./' + entry, './assets/%2fsecret.js')],
    ['untrusted attribute', (h: string) => h.replace('type="module" crossorigin', 'type="module" onload="steal()" crossorigin')],
    ['duplicate attribute', (h: string) => h.replace('type="module"', 'type="module" src="https://evil.example/x.js"')],
    ['missing marker', (h: string) => h.replace(marker, '')],
    ['duplicate marker', (h: string) => h.replace(marker, marker + marker)],
    ['marker outside the first inline script', (h: string) => h.replace(marker, '').replace('</head>', `<script>${marker}</script></head>`)],
    ['credentialed entry', (h: string) => h.replace('type="module" crossorigin', 'type="module" crossorigin="use-credentials"')],
  ])('rejects %s instead of shipping a speculative or partial entry', async (_name, change) => {
    await expect(transform(change(compiledHtml()))).rejects.toThrow()
  })

  it('refuses resources absent from the actual bundle and a non-entry entry', async () => {
    const missing = bundle(); delete missing[css]
    await expect(transform(compiledHtml(), missing)).rejects.toThrow()
    const wrong = bundle(); (wrong[entry] as OutputChunk).isEntry = false
    await expect(transform(compiledHtml(), wrong)).rejects.toThrow()
  })

  it('refuses missing static dependencies or missing Vite CSS metadata', async () => {
    const missing = bundle(); (missing[entry] as OutputChunk).imports.push('assets/missing.js')
    await expect(transform(compiledHtml(), missing)).rejects.toThrow(/static import/)
    const metadata = bundle()
    delete (metadata[entry] as OutputChunk & { viteMetadata?: unknown }).viteMetadata
    await expect(transform(compiledHtml(), metadata)).rejects.toThrow(/CSS metadata/)
  })

  it('refuses a stylesheet set that differs from the actual static entry graph', async () => {
    const output = bundle()
    const dependency = output[shared] as OutputChunk & { viteMetadata: { importedCss: Set<string> } }
    dependency.viteMetadata.importedCss.add('assets/other.css')
    await expect(transform(compiledHtml(), output)).rejects.toThrow(/stylesheet set/)
  })

  it('has explicit build-only/post ordering and never transforms DEV', () => {
    const plugin = configuredPlugins().find(p => p.name === 'shell-entry-assets')!
    expect(plugin?.apply).toBe('build')
    expect(plugin?.enforce).toBe('post')
    expect(plugin?.transformIndexHtml).toMatchObject({ order: 'post' })
  })
})

function emittedWorker(html: string) {
  const output = bundle()
  output['index.html'] = { type: 'asset', fileName: 'index.html', source: html } as OutputBundle[string]
  const plugin = configuredPlugins().find(p => p.name === 'critical-offline-assets')!
  const hook = plugin.generateBundle!
  const handler = typeof hook === 'function' ? hook : hook.handler
  const emitted: { source?: string | Uint8Array }[] = []
  handler.call({ emitFile: (file: { source?: string | Uint8Array }) => { emitted.push(file); return 'sw' } } as unknown as PluginContext, {} as NormalizedOutputOptions, output, false)
  expect(emitted).toHaveLength(1)
  return String(emitted[0].source)
}

describe('worker version includes the final compiled shell', () => {
  it('changes on an HTML-only edit with identical critical filenames and worker source', async () => {
    const html = await transform()
    const changed = html.replace('<title>', '<title>changed ')
    const first = emittedWorker(html), second = emittedWorker(changed)
    expect(first.match(/const CACHE_VERSION = '([^']+)'/)![1]).not.toBe(second.match(/const CACHE_VERSION = '([^']+)'/)![1])
    expect(first.match(/const CRITICAL_ASSETS = ([^\n]+)/)![1]).toBe(second.match(/const CRITICAL_ASSETS = ([^\n]+)/)![1])
  })

  it('refuses untransformed HTML and runs after Vite has emitted the final index', () => {
    expect(configuredPlugins().find(p => p.name === 'critical-offline-assets')!.enforce).toBe('post')
    expect(() => emittedWorker(compiledHtml())).toThrow(/shell|HTML/i)
  })

  it('refuses a second compiled injection marker before emitting a worker version', async () => {
    const html = await transform()
    const compiledMarker = '/* SHELL_ENTRY_ASSETS: parser-inserted v1 */'
    expect(() => emittedWorker(html.replace('</head>', compiledMarker + '</head>'))).toThrow(/shell|HTML/i)
  })
})
