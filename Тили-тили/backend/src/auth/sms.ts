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

const acceptedSmsStatuses = new Set([0, 1, 3, 4, 8])
type SmsFailure = 'http_error' | 'provider_rejected' | 'invalid_response' | 'message_rejected' | 'timeout' | 'network_error'

class SmsAeroSender implements SmsSender {
  readonly kind = 'smsaero'
  constructor(
    private readonly email: string,
    private readonly key: string,
    private readonly sign: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  private fail(reason: SmsFailure, status?: number): never {
    this.log.error({ reason, ...(status === undefined ? {} : { status }) }, 'smsaero отказал')
    throw new Error(`smsaero: ${reason}`)
  }

  async send(phone: string, text: string): Promise<void> {
    const number = phone.replace('+', '')
    const auth = Buffer.from(`${this.email}:${this.key}`).toString('base64')
    const signal = AbortSignal.timeout(10_000)
    let res: Response
    try {
      res = await fetch('https://gate.smsaero.ru/v2/sms/send', {
        method: 'POST',
        redirect: 'manual',
        headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
        body: new URLSearchParams({ number, text, sign: this.sign }),
        signal,
      })
    } catch (error) {
      return this.fail(signal.aborted || (error instanceof DOMException && error.name === 'TimeoutError') ? 'timeout' : 'network_error')
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      this.fail('http_error', res.status)
    }

    const body = (await res.json().catch(() => null)) as { success?: unknown; data?: unknown } | null
    if (signal.aborted) this.fail('timeout', res.status)
    if (body?.success === false) this.fail('provider_rejected', res.status)
    if (body?.success !== true || !Array.isArray(body.data) || body.data.length !== 1) {
      this.fail('invalid_response', res.status)
    }
    const result = body.data[0] as { id?: unknown; status?: unknown; number?: unknown } | null
    if (!result || typeof result.id !== 'number' || !Number.isSafeInteger(result.id) || result.id <= 0 || typeof result.status !== 'number') {
      this.fail('invalid_response', res.status)
    }
    const recipient = result.number
    if (recipient !== undefined && (
      (typeof recipient !== 'string' && typeof recipient !== 'number') || String(recipient).replace(/^\+/, '') !== number
    )) {
      this.fail('invalid_response', res.status)
    }
    if (result.status === 2 || result.status === 6) this.fail('message_rejected', res.status)
    if (!acceptedSmsStatuses.has(result.status)) this.fail('invalid_response', res.status)
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
