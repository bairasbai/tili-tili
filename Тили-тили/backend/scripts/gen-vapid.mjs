/* Ключи Web Push. Запускать один раз: `node scripts/gen-vapid.mjs`.
 *
 * Приватный ключ в репозиторий не попадает НИКОГДА — только в `.env`
 * и в переменные окружения хостинга. Публичный уезжает в браузер: он
 * и должен быть виден.
 */
import webpush from 'web-push'

const keys = webpush.generateVAPIDKeys()
console.log('Добавьте в .env (файл не коммитится):\n')
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`)
console.log('VAPID_SUBJECT=mailto:support@tili-tili.ru')
