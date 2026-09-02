import type { FastifyBaseLogger } from 'fastify'
import { maskPhone } from './otp.js'

/**
 * Отправка SMS вынесена за интерфейс, потому что провайдера ещё нет:
 * учётную запись SMSAero заводит владелец (План этап 1, ч. 17 п. 4).
 *
 * До этого работает `console`: код уходит в лог. Это НЕ заглушка «чтобы
 * компилировалось» — весь сценарий входа рабочий, не хватает только последней
 * мили. Прод с таким отправителем не поднимется: `createSender` требует
 * настоящего провайдера при NODE_ENV=production.
 */
export interface SmsSender {
  readonly kind: string
  send(phone: string, text: string): Promise<void>
}

export interface SmsConfig {
  provider: string | null
  smsAeroEmail: string | null
  smsAeroKey: string | null
  smsAeroSign: string | null
}

class ConsoleSender implements SmsSender {
  readonly kind = 'console'
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(phone: string, text: string): Promise<void> {
    this.log.warn({ phone: maskPhone(phone), text }, 'SMS не отправлена — провайдер не настроен, код в логе')
  }
}

class SmsAeroSender implements SmsSender {
  readonly kind = 'smsaero'
  constructor(
    private readonly email: string,
    private readonly key: string,
    private readonly sign: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async send(phone: string, text: string): Promise<void> {
    const url = new URL('https://gate.smsaero.ru/v2/sms/send')
    url.searchParams.set('number', phone.replace('+', ''))
    url.searchParams.set('text', text)
    url.searchParams.set('sign', this.sign)
    const auth = Buffer.from(`${this.email}:${this.key}`).toString('base64')

    const res = await fetch(url, {
      headers: { authorization: `Basic ${auth}` },
      // Без таймаута зависший провайдер держит запрос пользователя минутами.
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string } | null
    if (!res.ok || body?.success === false) {
      // Наружу эта ошибка не уходит: человеку всё равно, что у провайдера
      // кончились деньги. Ему говорят «не удалось отправить, попробуйте позже».
      this.log.error({ status: res.status, message: body?.message }, 'smsaero отказал')
      throw new Error('smsaero: ' + (body?.message ?? res.status))
    }
  }
}

export function createSender(config: SmsConfig, env: string, log: FastifyBaseLogger): SmsSender {
  if (config.provider === 'smsaero') {
    if (!config.smsAeroEmail || !config.smsAeroKey || !config.smsAeroSign) {
      throw new Error('SMS_PROVIDER=smsaero требует SMSAERO_EMAIL, SMSAERO_KEY и SMSAERO_SIGN')
    }
    return new SmsAeroSender(config.smsAeroEmail, config.smsAeroKey, config.smsAeroSign, log)
  }
  if (env === 'production') {
    throw new Error('В production нужен настоящий SMS_PROVIDER: с кодом в логе никто не войдёт')
  }
  return new ConsoleSender(log)
}

export function codeMessage(code: string): string {
  return `Тили-тили: код ${code}. Никому его не сообщайте.`
}
