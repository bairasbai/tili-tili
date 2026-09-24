// @vitest-environment jsdom
/*
 * F-RL-8-05 (хвост ревью 016) — сам дефект, а не только помощник под ним:
 * на `/us/chats` нижняя навигация пары подсвечивала ДВЕ вкладки, «Чаты» и
 * «Мы», потому что путь сравнивался через `startsWith`, а `/us/chats` лежит
 * внутри `/us`. Человек не видел, где он на самом деле.
 *
 * Проверка идёт по отрисованному компоненту, а не по чистой функции: именно
 * так тест падал бы на прежнем коде, где никакой функции не было вовсе.
 * Признак подсветки — цвет активной вкладки из токенов (`--rose-deep`), тот
 * же, по которому её видит человек.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { TabBar } from '@/components/chrome'
import { StoreProvider } from '@/lib/store'

const ACTIVE = 'text-[var(--rose-deep)]'

const litTabs = (path: string) => {
  const r = render(
    <MemoryRouter initialEntries={[path]}>
      <StoreProvider>
        <TabBar />
      </StoreProvider>
    </MemoryRouter>,
  )
  return [...r.container.querySelectorAll('button')].filter((b) => b.className.includes(ACTIVE))
}

describe('F-RL-8-05: нижняя навигация пары подсвечивает ровно одну вкладку', () => {
  afterEach(cleanup)

  it('на /us/chats подсвечена одна вкладка, и это «Чаты»', () => {
    const lit = litTabs('/us/chats')
    expect(lit, 'горело две вкладки сразу — «Чаты» и «Мы»').toHaveLength(1)
    expect(lit[0]!.textContent).toContain('Чаты')
  })

  it('внутри переписки — по-прежнему одна, «Чаты»', () => {
    const lit = litTabs('/us/chats/ch1')
    expect(lit).toHaveLength(1)
    expect(lit[0]!.textContent).toContain('Чаты')
  })

  it('на /us подсвечена одна, и это «Мы»', () => {
    const lit = litTabs('/us')
    expect(lit).toHaveLength(1)
    expect(lit[0]!.textContent).toContain('Мы')
  })

  it('на /home — одна, «Главная»', () => {
    const lit = litTabs('/home')
    expect(lit).toHaveLength(1)
    expect(lit[0]!.textContent).toContain('Главная')
  })

  it('на подэкране свадьбы ни одна вкладка не горит — там центральная кнопка', () => {
    expect(litTabs('/wedding/planb')).toHaveLength(0)
  })
})
