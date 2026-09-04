import { CONTRACT_OPERATIONS } from './contract/paths.generated.js'

/**
 * Гостевой токен стоит В АДРЕСЕ: `/gifts/{token}`, `/rsvp/{token}`,
 * `/join/{token}/…`. Значит, он попадает в лог каждого запроса — а лог
 * уезжает к хостеру, в сборщик ошибок и в выгрузку для отладки.
 *
 * Тот, кто читает логи, получил бы не просто доступ к чужой странице:
 * строка `POST /gifts/{token}/{giftId}/reserve` — это готовый ответ на
 * вопрос «кто что подарил», который §9 обещает не раскрывать никому.
 */

/** Имя параметра, значение которого — секрет: `guestToken`, `token`, `code`, `shareCode`. */
const SECRET_PARAM = /token|code/i

/**
 * Первые сегменты путей, у которых секрет стоит вторым, СОБИРАЮТСЯ ИЗ КОНТРАКТА,
 * а не перечисляются руками.
 *
 * Список руками уже разъехался с маршрутами и молча тёк: в нём был `invite`
 * (`/invite/{shareCode}`), но не было `invites` — а `/invites/{code}` это код
 * приглашения в команду, по которому принимающий получает роль вплоть до
 * `couple`. Не было и `guest-vendor`: он появился вместе с внешним чатом
 * подрядчика позже списка (ERR-0097). Пути похожи настолько, что глазом
 * разница не ловится, а тест на это не смотрел.
 *
 * Тот же приём, что с занятыми маршрутами в `app.ts`: список, выведенный из
 * источника правды, не забывает — новый путь с токеном закрывается сам,
 * без правки этого файла.
 */
const SECRET_AT_SECOND_SEGMENT: ReadonlySet<string> = new Set(
  CONTRACT_OPERATIONS.flatMap((op) => {
    const parts = op.url.split('/')
    const param = parts[2] ?? ''
    return parts.length > 2 && param.startsWith(':') && SECRET_PARAM.test(param) ? [parts[1] ?? ''] : []
  }),
)

export function maskUrl(url: string): string {
  const cut = url.indexOf('?')
  const path = cut === -1 ? url : url.slice(0, cut)
  const query = cut === -1 ? '' : url.slice(cut)

  const parts = path.split('/')
  if (parts.length > 2 && parts[2] && SECRET_AT_SECOND_SEGMENT.has(parts[1] ?? '')) parts[2] = '***'

  /* Альбом принимает гостевой токен строкой запроса, живой канал чата —
   * токен доступа: браузерный WebSocket заголовки ставить не умеет.
   * Оба секрета, оба попали бы в лог.
   *
   * Правило то же, что и для пути: маскируется параметр, В ИМЕНИ которого есть
   * `token` или `code`. Перечислять имена по одному — тот же список руками,
   * который уже подвёл выше. */
  const maskedQuery = query.replace(/([?&][^=&]*=)[^&]*/g, (whole, head: string) =>
    SECRET_PARAM.test(head) ? `${head}***` : whole,
  )
  return parts.join('/') + maskedQuery
}
