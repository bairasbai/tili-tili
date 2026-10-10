import type { OutputBundle, OutputChunk } from 'rollup'

export const SHELL_ENTRY_MARKER = '/* SHELL_ENTRY_ASSETS */'
export const COMPILED_SHELL_MARKER = '/* SHELL_ENTRY_ASSETS: parser-inserted v1 */'
type EntryAsset = { kind: 'style' | 'preload' | 'module'; file: string; crossOrigin: string | null }
type ViteChunk = OutputChunk & { viteMetadata?: { importedCss?: Set<string> } }

function requireShell(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error('Shell entry assets: ' + message)
}

function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  let rest = text.trim().replace(/\/$/, '').trim()
  while (rest) {
    const match = /^([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?(?:\s+|$)/i.exec(rest)
    requireShell(match, 'unsupported attribute syntax')
    const name = match[1].toLowerCase()
    requireShell(!(name in result), 'duplicate attribute: ' + name)
    result[name] = match[2] ?? match[3] ?? match[4] ?? ''
    rest = rest.slice(match[0].length)
  }
  return result
}

/** Run after Vite's HTML asset injection, against the actual current bundle. */
export function shellEntryAssets(html: string, bundle: OutputBundle): string {
  requireShell(html.split(SHELL_ENTRY_MARKER).length === 2, 'missing or duplicate injection marker')
  const first = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/i.exec(html)
  requireShell(first && !first[1].trim() && first[2].includes(SHELL_ENTRY_MARKER), 'marker must be in the first classic inline script')
  const assets: EntryAsset[] = []
  const cleaned = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>|<link\b([^>]*)>/gi, (tag, scriptAttrs: string | undefined, body: string | undefined, linkAttrs: string | undefined) => {
    const script = scriptAttrs !== undefined
    const attr = attributes(script ? scriptAttrs : linkAttrs!)
    if (script && !('src' in attr)) {
      requireShell(attr.type !== 'module', 'unexpected inline module')
      return tag
    }
    const kind = script ? 'module' : attr.rel === 'modulepreload' ? 'preload' : attr.rel === 'stylesheet' ? 'style' : null
    if (!kind) {
      requireShell(!/\.m?js(?:[?#]|$)|\.css(?:[?#]|$)/i.test(attr.href ?? ''), 'unsupported active asset link')
      return tag
    }
    requireShell(!script || (attr.type === 'module' && !body!.trim()), 'unsupported script entry')
    const allowed = script ? ['type', 'src', 'crossorigin'] : ['rel', 'href', 'crossorigin']
    requireShell(Object.keys(attr).every(key => allowed.includes(key)), 'unsupported asset attribute')
    requireShell(!('crossorigin' in attr) || ['', 'anonymous'].includes(attr.crossorigin), 'unsafe crossorigin')
    const url = attr[script ? 'src' : 'href']
    requireShell(typeof url === 'string' && /^\.\/assets\/[a-zA-Z0-9_.-]+\.(?:js|mjs|css)$/.test(url), 'unsafe asset URL')
    const file = url.slice(2), output = bundle[file]
    requireShell(output && output.fileName === file, 'asset missing from actual bundle: ' + file)
    requireShell(kind === 'style' ? output.type === 'asset' && file.endsWith('.css') : output.type === 'chunk' && /\.m?js$/.test(file), 'asset kind mismatch')
    requireShell(!assets.some(asset => asset.file === file), 'duplicate asset: ' + file)
    assets.push({ kind, file, crossOrigin: attr.crossorigin ?? null })
    return ''
  })
  const entries = assets.filter(asset => asset.kind === 'module')
  requireShell(entries.length === 1, 'exactly one module entry required')
  const entry = bundle[entries[0].file] as ViteChunk
  requireShell(entry.isEntry && Object.values(bundle).filter(output => output.type === 'chunk' && output.isEntry).length === 1, 'module is not the sole actual entry')
  const imported = new Set<string>(), styles = new Set<string>()
  function visit(chunk: ViteChunk) {
    requireShell(chunk.viteMetadata?.importedCss instanceof Set, 'missing Vite CSS metadata')
    for (const file of chunk.viteMetadata.importedCss) styles.add(file)
    for (const file of chunk.imports) {
      if (imported.has(file)) continue
      requireShell(file !== entry.fileName, 'entry imported by a dependency')
      imported.add(file)
      const output = bundle[file]
      requireShell(output?.type === 'chunk', 'static import missing from actual bundle')
      visit(output as ViteChunk)
    }
  }
  visit(entry)
  const same = (actual: string[], expected: Set<string>) => actual.sort().join('\n') === [...expected].sort().join('\n')
  requireShell(same(assets.filter(asset => asset.kind === 'preload').map(asset => asset.file), imported), 'preload set differs from actual static imports')
  requireShell(styles.size > 0 && same(assets.filter(asset => asset.kind === 'style').map(asset => asset.file), styles), 'stylesheet set differs from actual entry CSS')
  const rank = { style: 0, preload: 1, module: 2 }
  assets.sort((a, b) => rank[a.kind] - rank[b.kind])
  // Never expose a literal closing script tag inside the first inline script.
  const literal = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
  const boot = `${COMPILED_SHELL_MARKER}
        if (document.readyState !== 'loading') throw new Error('Shell entry requires the active HTML parser')
        if (!shellRoot || shellRoot.origin !== window.location.origin) throw new Error('Unsafe shell entry root')
        if (root !== null) {
          try { sessionStorage.setItem('tt_redirect', p + window.location.search + window.location.hash) } catch (e) { /* storage blocked */ }
        }
        var entryAssets = ${literal(assets)}
        document.write(entryAssets.map(function (asset) {
          var url = new URL('./' + asset.file, shellRoot)
          if (url.origin !== window.location.origin) throw new Error('Unsafe shell entry asset')
          var href = url.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
          var cross = asset.crossOrigin === null ? '' : ' crossorigin="' + asset.crossOrigin + '"'
          if (asset.kind === 'module') return ${literal('<script type="module"')} + cross + ${literal(' src="')} + href + ${literal('"></script>')}
          return ${literal('<link rel="')} + (asset.kind === 'style' ? 'stylesheet' : 'modulepreload') + '"' + cross + ${literal(' href="')} + href + ${literal('">')}
        }).join(''))
        return`
  return cleaned.replace(SHELL_ENTRY_MARKER, boot)
}
