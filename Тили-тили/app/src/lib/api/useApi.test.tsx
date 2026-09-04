// @vitest-environment jsdom
/*
 * Хук чтения: что остаётся на экране между запросами.
 *
 * Регрессия найдена живьём: ссылка на удалённую анкету открывала карточку
 * того подрядчика, которого смотрели до неё, — вместе с живой кнопкой
 * «Добавить в свадьбу». Данные прошлого запроса оставались в состоянии, и
 * проверка «анкета не пришла» не срабатывала, потому что в ней лежала чужая.
 *
 * Проверяем сам хук, а не экран: `MemoryRouter` читает `initialEntries` только
 * при первом рендере, и тест «перешли по другому адресу» через него молча
 * проверял бы одно и то же место дважды.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { useApi } from './useApi'
import { ApiError } from './client'

afterEach(cleanup)

describe('useApi: чужие данные не переживают смену запроса', () => {
  it('смена адреса стирает прошлый ответ до прихода нового', async () => {
    const answers: Record<string, string> = { a: 'Первый', b: 'Второй' }
    let slow: (() => void) | null = null

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useApi(async () => {
        /* Второй ответ задерживаем: важен именно промежуток, когда новый
           запрос ещё в пути. Раньше в нём висел предыдущий подрядчик. */
        if (id === 'b') await new Promise<void>(r => { slow = r })
        return answers[id]
      }, [id]),
      { initialProps: { id: 'a' } },
    )

    await waitFor(() => expect(result.current.data).toBe('Первый'))

    rerender({ id: 'b' })
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(true)

    slow!()
    await waitFor(() => expect(result.current.data).toBe('Второй'))
  })

  it('отказ сервера не оставляет данные рядом с сообщением об ошибке', async () => {
    let fail = false
    const { result } = renderHook(() => useApi(async () => {
      if (fail) throw new ApiError('http', 404, 'not_found', 'Анкета не найдена')
      return 'Анкета'
    }, [fail]))

    await waitFor(() => expect(result.current.data).toBe('Анкета'))

    fail = true
    result.current.reload()
    await waitFor(() => expect(result.current.error).toBe('Анкета не найдена'))
    // Показывать старое рядом с ошибкой значит утверждать, что оно актуально.
    expect(result.current.data).toBeNull()
  })

  it('перечитывание того же запроса не мигает пустотой', async () => {
    /* Список перечитывают после каждой галочки. Если бы сброс срабатывал и
       здесь, экран моргал бы на каждое действие. */
    let n = 0
    const { result } = renderHook(() => useApi(async () => `ответ ${++n}`, []))
    await waitFor(() => expect(result.current.data).toBe('ответ 1'))

    result.current.reload()
    expect(result.current.data).toBe('ответ 1')
    await waitFor(() => expect(result.current.data).toBe('ответ 2'))
  })
})
