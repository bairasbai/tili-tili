import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFile } from '@/test/projectFiles'

const html = projectFile('index.html')
const shellFiles = [
  ['manifest', 'manifest.webmanifest'],
  ['icon', 'icon.svg'],
  ['apple-touch-icon', 'icon-512.png'],
] as const
let originalHead: string
let originalUrl: string

beforeEach(() => {
  originalHead = document.head.innerHTML
  originalUrl = location.href
  sessionStorage.clear()
})
afterEach(() => {
  document.head.innerHTML = originalHead
  history.replaceState(null, '', originalUrl)
  sessionStorage.clear()
})

/** Actual HTML script and DOM URL resolution; currentScript is explicit unit context. */
function loadShell(path: string, blockedStorage = false) {
  history.replaceState(null, '', location.origin + path)
  document.head.innerHTML = new DOMParser().parseFromString(html, 'text/html').head.innerHTML
  const scripts = [...document.head.querySelectorAll<HTMLScriptElement>('script:not([src])')]
  expect(scripts.length, 'HTML shell has no inline script').toBeGreaterThan(0)
  const replaced: string[] = []
  const fakeWindow = {
    location: {
      pathname: path.split(/[?#]/)[0],
      search: location.search,
      hash: location.hash,
      origin: location.origin,
      replace: (url: string) => replaced.push(url),
    },
  }
  const storage = {
    setItem: (key: string, value: string) => {
      if (blockedStorage) throw new DOMException('Storage blocked', 'SecurityError')
      sessionStorage.setItem(key, value)
    },
  }
  const execute = () => {
    for (const script of scripts) {
      const context = vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script)
      try {
        new Function('window', 'document', 'sessionStorage', script.textContent!)(fakeWindow, document, storage)
      } finally {
        context.mockRestore()
      }
    }
  }
  execute()
  return { replaced, execute }
}

function expectShellAt(root: string) {
  for (const [rel, file] of shellFiles) {
    const links = document.head.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`)
    expect(links.length, `${rel} must be present exactly once`).toBe(1)
    expect(links[0].href, `${rel} after document URL changed`).toBe(new URL(root + file, location.origin).href)
    expect(new URL(links[0].href).origin).toBe(location.origin)
  }
}

describe('shell asset URLs remain at the application root after history navigation', () => {
  it.each([
    ['/', '/'],
    ['/index.html?launch=1#install', '/'],
    ['/preview/', '/preview/'],
    ['/preview/index.html?launch=1#install', '/preview/'],
  ])('keeps shell files from %s through nested routes', (entry, root) => {
    const { replaced } = loadShell(entry)
    expect(replaced).toEqual([])
    expectShellAt(root)
    for (const route of ['legal/privacy?lang=en#policy', 'join/guest?eventId=e&guestId=g#main-rsvp', 'wedding/guests/']) {
      history.replaceState(null, '', root + route)
      expectShellAt(root)
      const fragment = document.createElement('a')
      fragment.href = '#transfer'
      expect(fragment.href).toBe(new URL('#transfer', location.href).href)
    }
  })

  it.each(['/', '/preview/'])('anchors direct deep links, including trailing slash, under %s', (root) => {
    const deep = root + 'legal/privacy/?lang=en#policy'
    const { replaced } = loadShell(deep)
    expect(replaced).toEqual([location.origin + root])
    expect(sessionStorage.getItem('tt_redirect')).toBe(deep)
    expectShellAt(root)
    history.replaceState(null, '', root)
    expectShellAt(root)
    history.replaceState(null, '', deep)
    expectShellAt(root)
  })

  it('keeps hostile path prefixes and malformed embedded separators on the same origin', () => {
    for (const path of ['//evil.example/auth', '\\\\evil.example/auth', '/wedding//guests', '/x//evil.example/auth', '/x\\evil.example/auth', '/%2f%2fevil.example/auth']) {
      const { replaced } = loadShell(path)
      for (const url of replaced) expect(new URL(url).origin).toBe(location.origin)
      for (const [rel] of shellFiles) {
        const link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
        expect(link, `missing ${rel} at ${path}`).not.toBeNull()
        expect(new URL(link!.href).origin).toBe(location.origin)
      }
      if (path === '/wedding//guests' || path === '/x//evil.example/auth' || path === '/x\\evil.example/auth') {
        expect(replaced).toEqual([])
      }
    }
  })

  it('anchors the same shell when session storage is blocked', () => {
    const { replaced } = loadShell('/preview/legal/privacy?lang=ru#policy', true)
    expect(replaced).toEqual([location.origin + '/preview/'])
    expect(sessionStorage.getItem('tt_redirect')).toBeNull()
    history.replaceState(null, '', '/preview/legal/privacy?lang=ru#policy')
    expectShellAt('/preview/')
  })

  it('keeps exactly one of each shell link on repeated inline execution', () => {
    const { execute } = loadShell('/preview/')
    execute()
    history.replaceState(null, '', '/preview/wedding/guests')
    expectShellAt('/preview/')
  })
})
