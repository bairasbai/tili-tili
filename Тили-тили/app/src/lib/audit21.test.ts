/*
 * Аудит, блок 9: готовность к выпуску — то, что проверяется по файлам сборки.
 *
 *  — `apple-touch-icon` — PNG: iOS не понимает SVG в этом теге, и на «экране
 *    Домой» стоял бы серый квадрат;
 *  — `app/.env` игнорируется git: до блока 9 файл с ключами сборки лёг бы в
 *    репозиторий первым же `git add .`;
 *  — сервис-воркер показывает push и обрабатывает тап (блок 8) — иначе ключи
 *    VAPID ничего бы не включили;
 *  — Tailwind не предупреждает на сборке: длительность занавеса ушла в стиль
 *    (сканер Tailwind читает и комментарии — класс с миллисекундами в скобках
 *    здесь нельзя писать даже словами кода).
 */
import { describe, it, expect } from 'vitest'
import { projectFile } from '@/test/projectFiles'

describe('готовность к выпуску: файлы сборки', () => {
  it('apple-touch-icon указывает на PNG', () => {
    const html = projectFile('index.html')
    const m = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)
      ?? /<link rel="apple-touch-icon"[^>]+href="([^"]+)"/.exec(html)
    expect(m?.[1]).toBe('./apple-touch-icon.png')
  })

  it('манифест разделяет обычные и maskable PNG-иконки нового бренда', () => {
    const manifest = JSON.parse(projectFile('public/manifest.webmanifest')) as {
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>
    }
    expect(manifest.icons).toEqual([
      { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ])
  })

  it('app/.env не попадёт в репозиторий', () => {
    const ignore = projectFile('.gitignore').split(/\r?\n/).map(l => l.trim())
    expect(ignore).toContain('.env')
    expect(ignore).toContain('!.env.example')
  })

  it('сервис-воркер умеет push и тап по уведомлению', () => {
    const sw = projectFile('public/sw.js')
    expect(sw).toContain("addEventListener('push'")
    expect(sw).toContain("addEventListener('notificationclick'")
    expect(sw).toContain('showNotification')
  })

  it('в разметке нет классов длительности с квадратными скобками (Tailwind их не собирал)', () => {
    const invite = projectFile('src/pages/Invite.tsx')
    expect(invite).not.toMatch(/duration-\[\d+ms\]/)
  })
})
