/*
 * Квиз спрашивает диапазонами, сервер принимает числа.
 *
 * Перевод одного в другое — единственное место, где ответ человека
 * превращается в цифру, на которой потом строится весь бюджет и подбор
 * площадок. Ошибиться тут легко и незаметно: первая версия разбора бюджета
 * находила «млн» в любом месте строки и на «500 тыс — 1 млн ₽» отдавала
 * миллион, завысив нижнюю границу вдвое.
 *
 * Варианты ответов взяты дословно из `pages/Quiz.tsx` — если там поменяют
 * формулировку, тест обязан упасть, а не молча пропустить.
 */
import { describe, it, expect } from 'vitest'
import { budgetFromRange, guestsFromRange } from './api/wedding'

describe('бюджет из ответа квиза', () => {
  it('берёт нижнюю границу диапазона, а не любое число из строки', () => {
    /* В копейках: сервер хранит деньги в минорных единицах. */
    expect(budgetFromRange('До 500 тыс ₽')).toBe(500_000 * 100)
    expect(budgetFromRange('500 тыс — 1 млн ₽')).toBe(500_000 * 100)
    expect(budgetFromRange('1–2 млн ₽')).toBe(1_000_000 * 100)
    expect(budgetFromRange('2 млн+ ₽')).toBe(2_000_000 * 100)
  })

  it('«не знаем» — это не ноль', () => {
    /* Ноль на экране бюджета читается как «денег нет». Отсутствие ответа
       должно оставаться отсутствием. */
    expect(budgetFromRange('Пока не знаем')).toBeUndefined()
    expect(budgetFromRange(null)).toBeUndefined()
    expect(budgetFromRange('')).toBeUndefined()
  })
})

describe('гости из ответа квиза', () => {
  it('берёт нижнюю границу', () => {
    expect(guestsFromRange('До 30')).toBe(30)
    expect(guestsFromRange('30–60')).toBe(30)
    expect(guestsFromRange('60–100')).toBe(60)
    expect(guestsFromRange('100+')).toBe(100)
  })

  it('без ответа числа нет', () => {
    expect(guestsFromRange(null)).toBeUndefined()
    expect(guestsFromRange('')).toBeUndefined()
  })
})
