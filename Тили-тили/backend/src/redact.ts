/**
 * Гостевой токен стоит В АДРЕСЕ: `/gifts/{token}`, `/rsvp/{token}`,
 * `/join/{token}/…`. Значит, он попадает в лог каждого запроса — а лог
 * уезжает к хостеру, в сборщик ошибок и в выгрузку для отладки.
 *
 * Тот, кто читает логи, получил бы не просто доступ к чужой странице:
 * строка `POST /gifts/{token}/{giftId}/reserve` — это готовый ответ на
 * вопрос «кто что подарил», который §9 обещает не раскрывать никому.
 */
const SECRET_AT_SECOND_SEGMENT = new Set(['gifts', 'rsvp', 'join', 'invite'])

export function maskUrl(url: string): string {
  const cut = url.indexOf('?')
  const path = cut === -1 ? url : url.slice(0, cut)
  const query = cut === -1 ? '' : url.slice(cut)

  const parts = path.split('/')
  if (parts.length > 2 && parts[2] && SECRET_AT_SECOND_SEGMENT.has(parts[1] ?? '')) parts[2] = '***'

  // Альбом принимает токен строкой запроса — там он тоже секрет.
  return parts.join('/') + query.replace(/(guestToken=)[^&]*/gi, '$1***')
}
