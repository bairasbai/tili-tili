import type { OutputBundle, OutputChunk } from 'rollup'

export const CRITICAL_PAGES = ['Smart.tsx', 'Tools.tsx', 'VendorPrograms.tsx', 'GuestVendor.tsx'] as const

/** Follow actual static imports; lazy critical pages need their shared chunks too. */
export function criticalAssets(bundle: OutputBundle): string[] {
  const chunks = Object.values(bundle).filter((v): v is OutputChunk => v.type === 'chunk')
  if (!chunks.some(c => c.isEntry)) throw new Error('Critical offline entry missing from build')
  const roots = chunks.filter(c => c.isEntry || Object.keys(c.modules).some(id =>
    CRITICAL_PAGES.some(page => id.replaceAll('\\', '/').endsWith('/pages/' + page))))
  for (const page of CRITICAL_PAGES) {
    if (!roots.some(c => Object.keys(c.modules).some(id => id.replaceAll('\\', '/').endsWith('/pages/' + page)))) {
      throw new Error('Critical offline page missing from build: ' + page)
    }
  }
  const names = new Set<string>()
  function visit(file: string): void {
    if (names.has(file)) return
    const output = bundle[file]
    if (!output) throw new Error('Critical static import missing from build: ' + file)
    names.add(file)
    if (output.type === 'chunk') output.imports.forEach(visit)
  }
  roots.forEach(c => visit(c.fileName))
  Object.values(bundle).filter(v => v.type === 'asset' && /\.(css|woff2?|ttf|otf)$/i.test(v.fileName)).forEach(v => names.add(v.fileName))
  for (const file of names) {
    if (!/^assets\/[a-zA-Z0-9_.-]+\.(js|mjs|css|woff2?|ttf|otf)$/.test(file)) throw new Error('Unsafe critical static asset: ' + file)
  }
  return [...names].sort().map(file => './' + file)
}
