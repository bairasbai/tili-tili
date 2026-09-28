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

  it('в разметке нет классов длительности с квадратными скобками (Tailwind их не собирал)', () => {
    const invite = projectFile('src/pages/Invite.tsx')
    expect(invite).not.toMatch(/duration-\[\d+ms\]/)
  })
})
