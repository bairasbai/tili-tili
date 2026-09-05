/**
 * Русское склонение после числа.
 *
 * Строки обновлений читает подрядчик, и «за столами 1 гостей» в его кабинете
 * выглядит как поломка данных, а не как оговорка. На клиенте такой помощник
 * уже был (ERR-0135 про «44 мест» и «1 номеров») — теперь он есть и здесь,
 * потому что текст собирает сервер.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return many
  if (last > 1 && last < 5) return few
  if (last === 1) return one
  return many
}
