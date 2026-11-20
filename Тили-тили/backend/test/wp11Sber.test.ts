import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { parseManualTransfer } from '../src/service-plans/manualTransfer.js'
import { loadConfig } from '../src/config.js'
import { createSberSandboxGateway, createSberSandboxProvider } from '../src/service-plans/sberSandbox.js'

const orderId = '4fec34fe-3121-47d0-a9e3-87b6937b5e65'
const paymentId = 'a67b0ced-c9a4-4cfb-bce3-b9595afaafc1'
const checkout = {
  orderId, amount: 29900, currency: 'RUB' as const, description: 'Синтетические условия',
  returnPath: '/settings?serviceOrder=' + orderId, quoteExpiresAt: new Date(Date.now() + 600_000),
}
const formUrl = 'https://ecomtest.sberbank.ru/pp/pay_ru?orderId=' + paymentId
const mockCredentials = { userName: 'sandbox-user', password: 'sandbox-fixture' }
const returnOrigin = 'https://tili-test.example'
const orderCreatedAt = new Date(Date.now() - 5000)

function status(code: number, deposited: number, refunded: number) {
  return {
    success: true, data: { orderId: paymentId, orderNumber: orderId },
    orderStatus: {
      orderStatus: code, actionCode: 0, amount: checkout.amount, currency: '643',
      authDateTime: orderCreatedAt.getTime() + 1000,
      paymentAmountInfo: { depositedAmount: deposited, refundedAmount: refunded },
    },
  }
}

function fake(response: unknown) {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(response))
  return { send, gateway: createSberSandboxGateway(mockCredentials, returnOrigin, send) }
}

describe('WP11 Sber transfer display configuration', () => {
  const transfer = {
    url: 'https://www.sberbank.com/sms/pbpn?requisiteNumber=79990000000',
    qrJpegBase64: Buffer.from([255, 216, 32, 255, 217]).toString('base64'),
  }
  const fixture = { ...transfer, pairingSha256: createHash('sha256').update(transfer.url + '\n')
    .update(Buffer.from(transfer.qrJpegBase64, 'base64')).digest('hex') }
  it('is opt-in and accepts the configured URL with its JPEG', () => {
    expect(loadConfig({}).servicePlanManualTransfer).toBeNull()
    expect(parseManualTransfer(fixture)).toEqual(transfer)
    expect(() => loadConfig({ SERVICE_PLAN_MANUAL_TRANSFER_FILE: 'relative.json' })).toThrow('SERVICE_PLAN_MANUAL_TRANSFER_FILE')
  })
  it.each([
    'https://www.sberbank.com.evil.test/sms/pbpn?requisiteNumber=79990000000',
    'https://www.sberbank.com/sms/pbpn?requisiteNumber=79990000000&one=1',
    'http://www.sberbank.com/sms/pbpn?requisiteNumber=79990000000',
    'https://www.sberbank.com/sms/pbpn?requisiteNumber=wrong',
  ])('rejects an alternate or malformed destination: %s', url => {
    expect(() => parseManualTransfer({ ...fixture, url })).toThrow()
  })
  it('rejects another MIME payload', () => {
    expect(() => parseManualTransfer({ ...fixture, qrJpegBase64: btoa('<svg/>') })).toThrow('JPEG')
  })
  it('rejects replacing one member of a verified pairing', () => {
    expect(() => parseManualTransfer({ ...fixture, url: fixture.url.replace(/0$/, '1') })).toThrow('pairing')
  })
})

describe('WP11 Sber sandbox gateway contract', () => {
  it('registers a single СБП test order for the amount and reference', async () => {
    const { send, gateway } = fake({ errorCode: '0', formUrl, orderId: paymentId })
    await expect(gateway.register(checkout)).resolves.toEqual({ paymentId, confirmationUrl: formUrl })
    expect(send).toHaveBeenCalledTimes(1)
    const [address, request] = send.mock.calls[0]!
    expect(address).toBe('https://ecomtest.sberbank.ru/ecomm/gw/partner/api/v1/register.do')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-idempotencyKey': orderId } })
    expect(JSON.parse(String(request!.body))).toMatchObject({
      orderNumber: orderId, amount: 29900, currency: '643',
      returnUrl: returnOrigin + checkout.returnPath,
      jsonParams: { qrType: 'DYNAMIC_QR_SBP', 'sbp.scenario': 'C2B' },
    })
  })

  it.each([
    [0, 0, 0, 'pending'],
    [1, 0, 0, 'pending'],
    [6, 0, 0, 'canceled'],
    [2, 29900, 0, 'paid'],
    [4, 29900, 9900, 'paid'],
    [4, 29900, 29900, 'refunded'],
  ])('normalizes the authenticated status %d with deposited %d and returned %d', async (code, deposited, refunded, expected) => {
    const { send, gateway } = fake(status(code, deposited, refunded))
    await expect(gateway.readStatus(orderId, checkout.amount, orderCreatedAt)).resolves.toMatchObject({
      orderId, paymentId, amount: checkout.amount, state: expected, refundedAmount: refunded,
    })
    expect(send.mock.calls[0]?.[0]).toBe('https://ecomtest.sberbank.ru/ecomm/gw/partner/api/v1/getOrderStatusExtended.do')
  })

  it('refuses foreign order details, another amount, and unconfirmed withdrawal', async () => {
    const foreign = status(2, 29900, 0)
    foreign.data.orderNumber = paymentId
    await expect(fake(foreign).gateway.readStatus(orderId, checkout.amount, orderCreatedAt)).rejects.toMatchObject({ code: 'sber_sandbox_status_invalid' })
    await expect(fake(status(2, 29900, 0)).gateway.readStatus(orderId, 19900, orderCreatedAt)).rejects.toMatchObject({ code: 'sber_sandbox_status_invalid' })
    await expect(fake(status(2, 0, 0)).gateway.readStatus(orderId, checkout.amount, orderCreatedAt)).rejects.toMatchObject({ code: 'sber_sandbox_status_invalid' })
    await expect(fake({ errorCode: '0', formUrl: 'https://example.invalid', orderId: paymentId }).gateway.register(checkout))
      .rejects.toMatchObject({ code: 'sber_sandbox_status_invalid' })
  })

  it('rejects a contradiction and the authorization from before the local order', async () => {
    const response = status(2, 29900, 0)
    await expect(fake({ ...response, success: false, errorCode: '0' }).gateway.readStatus(orderId, 29900, orderCreatedAt))
      .rejects.toMatchObject({ code: 'sber_sandbox_rejected' })
    response.orderStatus.authDateTime = orderCreatedAt.getTime() - 60_001
    await expect(fake(response).gateway.readStatus(orderId, 29900, orderCreatedAt))
      .rejects.toMatchObject({ code: 'sber_sandbox_status_invalid' })
  })

  it('uses no second creation on a gateway timeout', async () => {
    const { gateway, send } = fake({})
    send.mockRejectedValueOnce(new Error('network timeout'))
    await expect(gateway.register(checkout)).rejects.toThrow('network timeout')
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('WP11 Sber acquiring test transport', () => {
  const config = { ...mockCredentials, returnOrigin }
  const request = { ...checkout, createdAt: orderCreatedAt, firstAttempt: true, claimRetry: async () => false }

  it('requires an explicit test-mode configuration', () => {
    expect(loadConfig({}).servicePlanSberSandbox).toBeNull()
    const settings = { SERVICE_PLAN_SBER_SANDBOX_ENABLED: 'true', SERVICE_PLAN_SBER_SANDBOX_USER: config.userName,
      SERVICE_PLAN_SBER_SANDBOX_PASSWORD: config.password, SERVICE_PLAN_SBER_SANDBOX_RETURN_ORIGIN: config.returnOrigin }
    expect(() => loadConfig(settings)).toThrow('NODE_ENV=test')
    expect(() => loadConfig({ ...settings, NODE_ENV: 'test', SERVICE_PLAN_SBER_SANDBOX_PASSWORD: '' })).toThrow('HTTPS')
    expect(loadConfig({ ...settings, NODE_ENV: 'test' }).servicePlanSberSandbox).toEqual(config)
  })

  it.each([
    'postgres://test@192.0.2.1:15432/local_test',
    'postgres://test@127.0.0.1:5432/local_test',
    'postgres://test@127.0.0.1:15432/local',
    'postgres://test@127.0.0.1:15432/local_test?host=example.invalid&port=5432',
  ])('rejects an unsafe sandbox database URL before creating the app: %s', async databaseUrl => {
    await expect(buildApp({ env: 'test', databaseUrl, servicePlanSberSandbox: config }))
      .rejects.toThrow('isolated local test database')
  })

  it('returns the registered payment as pending, then reconciles the same order', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errorCode: '0', orderId: paymentId, formUrl }))
      .mockResolvedValueOnce(Response.json(status(0, 0, 0)))
      .mockResolvedValueOnce(Response.json(status(2, 29900, 0)))
      .mockResolvedValueOnce(Response.json(status(4, 29900, 29900)))
    const provider = createSberSandboxProvider(config, send)
    await expect(provider.ensurePayment(request)).resolves.toMatchObject({ confirmationUrl: formUrl, status: { state: 'pending' } })
    await expect(provider.ensurePayment({ ...request, firstAttempt: false }))
      .resolves.toMatchObject({ confirmationUrl: formUrl, status: { paymentId, state: 'pending' } })
    await expect(provider.readPayment(orderId, request)).resolves.toMatchObject({ state: 'paid' })
    await expect(provider.readPayment(orderId, request)).resolves.toMatchObject({ state: 'refunded' })
    expect(send.mock.calls.map(([address]) => String(address).split('/').at(-1))).toEqual([
      'register.do', 'getOrderStatusExtended.do', 'getOrderStatusExtended.do', 'getOrderStatusExtended.do',
    ])
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body)).orderNumber).toBe(orderId)
  })

  it('recovers an uncertain registration by lookup and rejects another payment amount', async () => {
    const send = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('registration timeout'))
      .mockResolvedValueOnce(Response.json(status(0, 0, 0)))
      .mockResolvedValueOnce(Response.json(status(2, 29900, 0)))
    const provider = createSberSandboxProvider(config, send)
    await expect(provider.ensurePayment(request)).resolves.toMatchObject({ confirmationUrl: formUrl, status: { paymentId } })
    await expect(provider.readPayment(orderId, { ...request, amount: 19900 }))
      .rejects.toMatchObject({ code: 'sber_sandbox_status_invalid' })
    expect(send.mock.calls.filter(([address]) => String(address).endsWith('/register.do'))).toHaveLength(1)
  })

  it('retries the same merchant order only upon verified absence and a claim', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errorCode: '5', errorMessage: 'Заказ не найден' }))
      .mockResolvedValueOnce(Response.json({ errorCode: 0, orderId: paymentId, formUrl }))
      .mockResolvedValueOnce(Response.json({ errorCode: '5', errorMessage: 'Доступ запрещен' }))
    const provider = createSberSandboxProvider(config, send)
    const claimRetry = vi.fn(async () => true)
    await expect(provider.ensurePayment({ ...request, firstAttempt: false, claimRetry }))
      .resolves.toMatchObject({ confirmationUrl: formUrl, status: { paymentId, state: 'pending' } })
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body)).orderNumber).toBe(orderId)
    await expect(provider.ensurePayment({ ...request, firstAttempt: false, claimRetry }))
      .rejects.toMatchObject({ code: 'sber_sandbox_rejected' })
    expect(claimRetry).toHaveBeenCalledTimes(1)
  })

  it('omits the form URL if the registration response arrives after expiry', async () => {
    const quoteExpiresAt = new Date(Date.now() + 5000)
    const send = vi.fn<typeof fetch>().mockImplementation(async () => {
      quoteExpiresAt.setTime(Date.now() - 100)
      return Response.json({ errorCode: '0', orderId: paymentId, formUrl })
    })
    const provider = createSberSandboxProvider(config, send)
    await expect(provider.ensurePayment({ ...request, quoteExpiresAt }))
      .resolves.toMatchObject({ confirmationUrl: null, status: { paymentId, state: 'pending' } })
  })
})
