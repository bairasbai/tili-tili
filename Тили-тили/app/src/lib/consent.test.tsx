// @vitest-environment jsdom
/*
 * Согласие на обработку персональных данных (152-ФЗ, план §18.1).
 *
 * Требование закона: согласие даётся явным действием. Предустановленная
 * галочка согласием не считается, а без согласия регистрацию продолжать
 * нельзя. Здесь это и проверяется — вместе с наличием самих документов.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { Auth } from '@/pages/Account'
import { Offer, Privacy } from '@/pages/Legal'

const wrap = (node: React.ReactNode) =>
  render(<MemoryRouter><StoreProvider>{node}</StoreProvider></MemoryRouter>)

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('согласие на обработку данных', () => {
  it('галочка не стоит заранее', () => {
    wrap(<Auth />)
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem('tt_consent')).toBeNull()
  })

  it('без согласия вход недоступен', () => {
    wrap(<Auth />)
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('согласие даётся нажатием и фиксируется с датой', () => {
    wrap(<Auth />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true')
    /* Кнопка ждёт ещё и телефон: код запрашивается у сервера, и запрос без
       номера отправлять некуда. Согласие — необходимое условие, не достаточное. */
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(false)
    const saved = JSON.parse(localStorage.getItem('tt_consent')!)
    expect(typeof saved.at).toBe('string')
    expect(Number.isNaN(Date.parse(saved.at))).toBe(false)
  })

  it('одного согласия мало — без телефона код не запросить', () => {
    wrap(<Auth />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('неполный номер кнопку не открывает', () => {
    wrap(<Auth />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '91712345' } })
    expect(screen.getByText('Получить код').closest('button')!.hasAttribute('disabled')).toBe(true)
  })

  it('согласие можно снять', () => {
    wrap(<Auth />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false')
    expect(JSON.parse(localStorage.getItem('tt_consent')!)).toBeNull()
  })
})

describe('юридические экраны', () => {
  it('оферта открывается и помечена черновиком', () => {
    wrap(<Offer />)
    expect(screen.getByText('Черновик.')).toBeTruthy()
    expect(screen.getByText(/Площадка не является стороной сделки/)).toBeTruthy()
  })

  it('политика открывается и называет место хранения данных', () => {
    wrap(<Privacy />)
    expect(screen.getByText('Черновик.')).toBeTruthy()
    expect(screen.getByText(/Российской Федерации/)).toBeTruthy()
  })
})
