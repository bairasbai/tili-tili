// @vitest-environment jsdom
/*
 * Аудит, блок 7: тексты и данные — ничего не обещать за код (R-174).
 *
 * Строки, которые здесь запрещены, стояли на экранах и обещали то, чего в
 * коде нет: бонус «3 000 ₽ на премиум-функции» без начисления и без платных
 * функций, «ИИ-координатор» без модели, «все участники узнают сразу» без
 * канала к гостям, «+ 100 км» без радиуса в запросе, «запас +2 заложен
 * автоматически» при точной сводке, «отмена блокирует отзывы» без такого
 * правила, «человек сразу потеряет доступ» при отзыве ссылки, «с согласия
 * пар» под примерами редакции, тумблер советов, которых никто не шлёт.
 * Проверка — по исходникам экранов: если фраза вернётся, тест покраснеет.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { projectFile } from '@/test/projectFiles'
import { plural } from '@/lib/utils'
import App from '@/App'

const FORBIDDEN_PROMISES = [
  'на премиум-функции',
  'ИИ-координатор, который помнит',
  'все участники узнают сразу',
  'синхронизируются мгновенно',
  ' + 100 км',
  'заложено в сводку автоматически',
  'блокирует отзывы обеим сторонам',
  'человек сразу потеряет доступ',
  'публикуются с согласия пар',
  'Советы ИИ-координатора',
  'с отметкой «выезд»',
  'загрузите скан в сделку',
  'Изменения мгновенно видны',
  /* Ревью D3-06: рассылок гостям нет — сервер уведомляет только команду в
     приложении, очереди доставки не существует. */
  'поставлены в очередь',
  'В очереди ✓',
  'Отправить гостям точки сбора',
  /* Ревью D3-02: платёжного провайдера нет — взнос в фонд и складчину это
     запись обещания, а не перевод денег; «Собрано» утверждало поступление. */
  'Перевести на цель',
  'перевод на цель',
  'переводят на цель',
  'Собрано',
]

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'ui') out.push(...sources(p)) }
    else if (/\.tsx?$/.test(e.name) && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

describe('тексты экранов не обещают того, чего нет в коде', () => {
  it('ни одна из запрещённых фраз не стоит в строке интерфейса', () => {
    const hits: string[] = []
    for (const f of [...sources('src/pages'), ...sources('src/components')]) {
      const src = projectFile(f)
      /* Только строки t('…'): комментарии, объясняющие, что и почему снято,
         эти фразы называть могут. */
      for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'\)/g)) {
        for (const bad of FORBIDDEN_PROMISES) if (m[1]!.includes(bad)) hits.push(`${f}: «${bad}»`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('числительные согласуются с глаголом', () => {
  it('«1 гость ещё не ответил», а не «не ответили»', () => {
    const phrase = (n: number) => `${n} ${plural(n, 'гость ещё не ответил', 'гостя ещё не ответили', 'гостей ещё не ответили')}`
    expect(phrase(1)).toBe('1 гость ещё не ответил')
    expect(phrase(3)).toBe('3 гостя ещё не ответили')
    expect(phrase(11)).toBe('11 гостей ещё не ответили')
    expect(phrase(21)).toBe('21 гость ещё не ответил')
  })
})

/* Сеть по таблице, как в audit17. */
function serve(routes: Record<string, unknown>) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0] ?? ''
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    return Promise.resolve(json(routes[path]))
  }))
}

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' } }

describe('экраны говорят правду о данных', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('главная: незаданный итог бюджета — «итог не задан», а не «из 0 ₽»', async () => {
    serve({
      '/weddings': [WEDDING], '/weddings/w1': WEDDING, '/weddings/w1/slots': [], '/weddings/w1/tasks': [], '/weddings/w1/guests': [],
      '/weddings/w1/budget': { total: { amount: 0, currency: 'RUB' }, spent: { amount: 5_000_000, currency: 'RUB' }, items: [] },
      '/notifications': [], '/me/favorites': [],
    })
    const { container } = render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(container.textContent).toContain('итог не задан'), { timeout: 4000 })
    expect(container.textContent).not.toContain('из 0 ₽')
    /* Процент бюджета без итога — прочерк; «0% готово» рядом относится к
       чек-листу и здесь не при чём. */
    expect(container.textContent).not.toMatch(/БЮДЖЕТ0%/i)
  })

  it('гости: у одного молчащего гостя глагол в единственном числе', async () => {
    serve({
      '/weddings': [WEDDING], '/weddings/w1': WEDDING, '/weddings/w1/slots': [],
      '/weddings/w1/guests': [{ id: 'g1', name: 'Ольга', status: 'pending', plusOne: false }],
      '/notifications': [], '/me/favorites': [],
    })
    const { container } = render(<MemoryRouter initialEntries={['/wedding/guests']}><App /></MemoryRouter>)
    await waitFor(() => expect(container.textContent).toContain('1 гость ещё не ответил'), { timeout: 4000 })
    expect(container.textContent).not.toContain('1 гость ещё не ответили')
  })
})
