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
import { runInNewContext } from 'node:vm'
import { describe, it, expect, vi } from 'vitest'
import { projectFile } from '@/test/projectFiles'

describe('готовность к выпуску: файлы сборки', () => {
  it('apple-touch-icon указывает на PNG', () => {
    const html = projectFile('index.html')
    const m = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)
    expect(m?.[1]).toMatch(/\.png$/)
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

  it('показывает уведомление по умолчанию при JSON null в Push', () => {
    type PushEvent = { data: { json: () => unknown }; waitUntil: (promise: Promise<void>) => void }
    const listeners = new Map<string, (event: PushEvent) => void>()
    const shown = Promise.resolve()
    const showNotification = vi.fn(() => shown)
    const waitUntil = vi.fn()
    runInNewContext(projectFile('public/sw.js'), {
      URL,
      self: {
        registration: { scope: 'http://127.0.0.1/', showNotification },
        addEventListener: (name: string, handler: (event: PushEvent) => void) => listeners.set(name, handler),
      },
    })
    listeners.get('push')!({ data: { json: () => null }, waitUntil })
    expect(showNotification).toHaveBeenCalledExactlyOnceWith('Тили-тили', {
      body: '', icon: './icon.svg', badge: './icon.svg', data: {},
    })
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(shown)
  })

  it('в разметке нет классов длительности с квадратными скобками (Tailwind их не собирал)', () => {
    const invite = projectFile('src/pages/Invite.tsx')
    expect(invite).not.toMatch(/duration-\[\d+ms\]/)
  })
})
