import { AppError } from '../errors.js'
import { isUuid } from '../ids.js'
import type { VerifiedPayment } from './orders.js'
import type { ServicePaymentRequest } from './provider.js'

const origin = 'https://ecomtest.sberbank.ru'
const gateway = origin + '/ecomm/gw/partner/api/v1/'
const rub = '643'
const clockSkewMs = 60_000
export const SBER_SANDBOX = 'sber_sandbox'

type JsonObject = Record<string, unknown>
type Credentials = { userName: string; password: string }

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function invalidStatus(): never {
  throw new AppError(502, 'sber_sandbox_status_invalid', 'Шлюз Сбера вернул неподтверждённый статус заказа')
}

function safeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function paymentSnapshot(response: JsonObject, orderId: string, expectedAmount: number, createdAt: Date): VerifiedPayment {
  const status = object(response.orderStatus) ?? response
  const identity = object(response.data) ?? response
  const attributes = Array.isArray(response.attributes) ? response.attributes : []
  const providerId = identity.orderId ?? attributes.find(entry => object(entry)?.name === 'mdOrder')?.value
  if (!isUuid(providerId) || identity.orderNumber !== orderId || status.amount !== expectedAmount || status.currency !== rub) {
    invalidStatus()
  }

  const amounts = object(status.paymentAmountInfo)
  const deposited = amounts?.depositedAmount
  const refundedAmount = amounts?.refundedAmount
  if (!safeAmount(deposited) || !safeAmount(refundedAmount) || refundedAmount > deposited || deposited > expectedAmount) {
    invalidStatus()
  }
  const common = { orderId, paymentId: providerId, provider: SBER_SANDBOX, amount: expectedAmount, currency: 'RUB', refundedAmount }
  switch (status.orderStatus) {
    case 0:
    case 1:
      if (deposited === 0) return { ...common, state: 'pending' }
      return invalidStatus()
    case 3:
    case 6:
      if (deposited === 0) return { ...common, state: 'canceled' }
      return invalidStatus()
    case 2:
    case 4: {
      const timestamp = status.depositedDate ?? status.authDateTime
      if (status.actionCode !== 0 || deposited !== expectedAmount || typeof timestamp !== 'number' ||
          !Number.isFinite(timestamp) || timestamp <= 0) invalidStatus()
      if ((status.orderStatus === 4 && refundedAmount === 0) ||
          (status.orderStatus === 2 && refundedAmount === expectedAmount)) invalidStatus()
      const paidAt = new Date(timestamp)
      if (!Number.isFinite(paidAt.getTime()) || timestamp < createdAt.getTime() - clockSkewMs ||
          timestamp > Date.now() + clockSkewMs) invalidStatus()
      return refundedAmount === expectedAmount ? { ...common, state: 'refunded', paidAt } : { ...common, state: 'paid', paidAt }
    }
    default:
      return invalidStatus()
  }
}

export function createSberSandboxGateway(credentials: Credentials, returnOrigin: string, send: typeof fetch = fetch) {
  const callbackOrigin = new URL(returnOrigin)
  if (callbackOrigin.protocol !== 'https:' || callbackOrigin.username || callbackOrigin.password ||
      callbackOrigin.pathname !== '/' || callbackOrigin.search || callbackOrigin.hash) {
    throw new Error('Expected an HTTPS return origin')
  }

  async function request(method: 'register.do' | 'getOrderStatusExtended.do', data: JsonObject, idempotency?: string) {
    const result = await send(gateway + method, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idempotency ? { 'x-idempotencyKey': idempotency } : {}),
      },
      redirect: 'error',
      body: JSON.stringify({ ...data, userName: credentials.userName, password: credentials.password }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!result.ok) throw new AppError(502, 'sber_sandbox_unavailable', 'Тестовый шлюз Сбера недоступен')
    const response = object(await result.json())
    if (!response || (response.success !== undefined && response.success !== true) ||
        !(response.errorCode === '0' || response.errorCode === 0 ||
          (response.errorCode === undefined && response.success === true))) {
      throw new AppError(502, 'sber_sandbox_rejected', 'Тестовый шлюз Сбера отклонил запрос')
    }
    return response
  }

  function validateOrder(orderId: string, amount: number) {
    if (!isUuid(orderId) || !safeAmount(amount) || amount === 0 || amount > 999_999_999_999) {
      throw new Error('Invalid Sber sandbox order')
    }
  }

  return {
    // One registration attempt. The caller reconciles an uncertain outcome
    // by orderNumber before it considers issuing another registration.
    async register(order: ServicePaymentRequest): Promise<{ paymentId: string; confirmationUrl: string | null }> {
      validateOrder(order.orderId, order.amount)
      const expectedQuery = '?serviceOrder=' + order.orderId
      const url = new URL(order.returnPath, callbackOrigin)
      if (url.origin !== callbackOrigin.origin || !['/settings', '/vendor-app/settings'].includes(url.pathname) ||
          url.search !== expectedQuery || url.hash) throw new Error('Invalid Sber return path')
      const sessionTimeoutSecs = Math.floor((order.quoteExpiresAt.getTime() - Date.now()) / 1000)
      if (!Number.isInteger(sessionTimeoutSecs) || sessionTimeoutSecs <= 0 || sessionTimeoutSecs > 1800) {
        throw new Error('Invalid Sber sandbox quote expiry')
      }
      const response = await request('register.do', {
        orderNumber: order.orderId,
        amount: order.amount,
        currency: rub,
        returnUrl: url.href,
        sessionTimeoutSecs,
        description: 'Тили-тили. Тестовый заказ',
        jsonParams: { qrType: 'DYNAMIC_QR_SBP', 'sbp.scenario': 'C2B' },
      }, order.orderId)
      if (!isUuid(response.orderId)) invalidStatus()
      if (response.formUrl === undefined) return { paymentId: response.orderId, confirmationUrl: null }
      if (typeof response.formUrl !== 'string') return invalidStatus()
      let form: URL
      try { form = new URL(response.formUrl) } catch { return invalidStatus() }
      if (form.origin !== origin || form.username || form.password || form.searchParams.get('orderId') !== response.orderId) invalidStatus()
      return { paymentId: response.orderId, confirmationUrl: form.href }
    },
    async readStatus(orderId: string, expectedAmount: number, createdAt: Date): Promise<VerifiedPayment> {
      validateOrder(orderId, expectedAmount)
      if (!Number.isFinite(createdAt.getTime())) throw new Error('Invalid local order creation time')
      return paymentSnapshot(await request('getOrderStatusExtended.do', { orderNumber: orderId }), orderId, expectedAmount, createdAt)
    },
  }
}
