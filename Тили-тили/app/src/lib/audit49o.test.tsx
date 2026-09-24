// @vitest-environment jsdom
/*
 * FL-17 / F-RL-8-12 (хвост ревью 016) — кабинет подрядчика без анкеты
 * отказывал НЕ ТОЙ причиной.
 *
 * Пара попадает в кабинет в два тапа: «Мы» → «Кабинет подрядчика» → «Сделки».
 * Вход законный — это воронка, через неё пара и становится подрядчиком.
 * Сервер отвечает честно: 403 «Кабинет доступен только подрядчику с анкетой»
 * (`vendor.ts`, `requireVendorId`). А экран печатал умолчальный текст
 * `AsyncState` про роль — «Этот раздел ведёт пара — у вашей роли к нему
 * доступа нет». Роль тут ни при чём: у человека просто нет анкеты (R-270 —
 * отказ называет причину, верную для спросившего; R-176 — раздел предлагал
 * себя, имея единственным исходом отказ).
 *
 * Дашборд кабинета это состояние обрабатывал (`VendorNoProfile`), остальные
 * пять экранов — нет. Проверяем все пять.
 *
 * `VendorVerification` в список не входит намеренно: она читает анкету через
 * `getVendorProfile().catch(noProfile)` и 404 ловит сама, до `AsyncState`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { StoreProvider } from '@/lib/store'
import { VendorDeals } from '@/pages/VendorApp'
import { VendorDealCard, VendorLead, VendorReviews, VendorAnalytics } from '@/pages/VendorExtras'

const WRONG = 'Этот раздел ведёт пара'
const RIGHT = 'Кабинет доступен только подрядчику с анкетой'
const CTA = 'Заполнить анкету'

/** Всё, что кабинет спрашивает у сервера, отвечает 403 «нужна анкета». */
function serveDenied() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'forbidden', message: RIGHT } }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
      ),
    ),
  )
}

const open = (node: React.ReactNode, route = '/vendor-app/deals', path = '/vendor-app/deals') =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <StoreProvider>
        <Routes>
          <Route path={path} element={node} />
        </Routes>
      </StoreProvider>
    </MemoryRouter>,
  )

const SCREENS: [string, () => ReturnType<typeof open>][] = [
  ['Сделки', () => open(<VendorDeals />)],
  ['Карточка сделки', () => open(<VendorDealCard />, '/vendor-app/deals/d1', '/vendor-app/deals/:id')],
  ['Заявка', () => open(<VendorLead />, '/vendor-app/leads/l1', '/vendor-app/leads/:id')],
  ['Отзывы', () => open(<VendorReviews />, '/vendor-app/reviews', '/vendor-app/reviews')],
  ['Аналитика', () => open(<VendorAnalytics />, '/vendor-app/analytics', '/vendor-app/analytics')],
]

describe('FL-17: кабинет без анкеты называет верную причину и даёт выход', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  for (const [name, mount] of SCREENS) {
    it(`«${name}»: причина про анкету, а не про роль`, async () => {
      serveDenied()
      const r = mount()
      await waitFor(() => expect(r.container.textContent).toContain(RIGHT), { timeout: 4000 })
      expect(r.container.textContent, 'отказ называет роль вместо отсутствия анкеты').not.toContain(WRONG)
      expect(r.container.textContent).toContain(CTA)
    })
  }

  it('кнопка ведёт в мастер анкеты, а не в никуда', async () => {
    serveDenied()
    const r = render(
      <MemoryRouter initialEntries={['/vendor-app/deals']}>
        <StoreProvider>
          <Routes>
            <Route path="/vendor-app/deals" element={<VendorDeals />} />
            <Route path="/vendor-app/profile" element={<p>мастер анкеты</p>} />
          </Routes>
        </StoreProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(r.container.textContent).toContain(CTA), { timeout: 4000 })
    fireEvent.click(r.getByText(CTA))
    await waitFor(() => expect(r.container.textContent).toContain('мастер анкеты'))
  })
})
