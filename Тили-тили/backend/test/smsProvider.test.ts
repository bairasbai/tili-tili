import type { FastifyBaseLogger } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { createSender } from '../src/auth/sms.js'

const phone = '+70000000000'
const text = 'synthetic SMS content'
const providerMessage = 'synthetic provider diagnostic containing SMS content'
const database = process.env.TEST_DATABASE_URL
const smsConfig = {
  provider: 'smsaero', smsAeroEmail: 'sms@example.invalid', smsAeroKey: 'synthetic-key', smsAeroSign: 'Test',
}

function fixture() {
  const fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  const error = vi.fn()
  const sender = createSender(smsConfig, 'test', { error } as unknown as FastifyBaseLogger)
  return { sender, fetchMock, error }
}

afterEach(() => vi.unstubAllGlobals())

describe('SMS Aero single recipient', () => {
  it('keeps the recipient and message in the form body', async () => {
    const { sender, fetchMock } = fixture()
    fetchMock.mockResolvedValueOnce(Response.json({ success: true, data: [{ id: 1, status: 0 }] }))
    await sender.send(phone, text)
    const [url, options] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://gate.smsaero.ru/v2/sms/send')
    expect(options?.method).toBe('POST')
    expect(options?.redirect).toBe('manual')
    expect(Object.fromEntries(options?.body as URLSearchParams)).toEqual({ number: phone.slice(1), text, sign: 'Test' })
  })

  it('rejects a redirect and releases the response body without reading it', async () => {
    const { sender, fetchMock, error } = fixture()
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
      status: 307, headers: { location: 'https://other.example.invalid/sms' },
    }))
    await expect(sender.send(phone, text)).rejects.toThrow('smsaero: http_error')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledExactlyOnceWith({ reason: 'http_error', status: 307 }, 'smsaero отказал')
  })

  it.each([0, 1, 3, 4, 8])('accepts documented provider status %s', async (status) => {
    const { sender, fetchMock, error } = fixture()
    fetchMock.mockResolvedValueOnce(Response.json({ success: true, data: [{ id: 1, status, text, number: phone.slice(1) }] }))
    await expect(sender.send(phone, text)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'non-OK HTTP', response: () => Response.json({ message: providerMessage }, { status: 503 }), reason: 'http_error', status: 503 },
    { name: 'provider rejection', response: () => Response.json({ success: false, message: providerMessage }), reason: 'provider_rejected', status: 200 },
    { name: 'non-JSON HTTP 200', response: () => new Response(providerMessage), reason: 'invalid_response', status: 200 },
    { name: 'missing success', response: () => Response.json({ data: [{ id: 1, status: 0 }] }), reason: 'invalid_response', status: 200 },
    { name: 'empty result', response: () => Response.json({ success: true, data: [] }), reason: 'invalid_response', status: 200 },
    { name: 'result without ID', response: () => Response.json({ success: true, data: [{ status: 0 }] }), reason: 'invalid_response', status: 200 },
    { name: 'different recipient', response: () => Response.json({ success: true, data: [{ id: 1, status: 0, number: '70000000001' }] }), reason: 'invalid_response', status: 200 },
    { name: 'unknown message status', response: () => Response.json({ success: true, data: [{ id: 1, status: 12 }] }), reason: 'invalid_response', status: 200 },
    { name: 'undelivered message', response: () => Response.json({ success: true, data: [{ id: 1, status: 2 }] }), reason: 'message_rejected', status: 200 },
    { name: 'rejected message', response: () => Response.json({ success: true, data: [{ id: 1, status: 6 }] }), reason: 'message_rejected', status: 200 },
  ])('fails on $name without logging the response', async ({ response, reason, status }) => {
    const { sender, fetchMock, error } = fixture()
    fetchMock.mockResolvedValueOnce(response())
    await expect(sender.send(phone, text)).rejects.toThrow(`smsaero: ${reason}`)
    expect(error).toHaveBeenCalledExactlyOnceWith({ reason, status }, 'smsaero отказал')
  })

  it.each([
    [new DOMException(providerMessage, 'TimeoutError'), 'timeout'],
    [new Error(providerMessage, { cause: new Error(text) }), 'network_error'],
  ])('keeps transport diagnostics free of SMS content', async (failure, reason) => {
    const { sender, fetchMock, error } = fixture()
    fetchMock.mockRejectedValueOnce(failure)
    await expect(sender.send(phone, text)).rejects.toThrow(`smsaero: ${reason}`)
    expect(error).toHaveBeenCalledExactlyOnceWith({ reason }, 'smsaero отказал')
  })
})

describe.skipIf(!database)('SMS Aero login', () => {
  it('returns a retriable error and drops the unused code when the gateway cannot confirm submission', async () => {
    const { fetchMock } = fixture()
    const app = await buildApp({
      env: 'test', databaseUrl: database!, redisUrl: null, sentryDsn: null,
      jwtAccessSecret: 'a'.repeat(48), jwtRefreshSecret: 'b'.repeat(48),
      smsProvider: smsConfig.provider, smsAeroEmail: smsConfig.smsAeroEmail,
      smsAeroKey: smsConfig.smsAeroKey, smsAeroSign: smsConfig.smsAeroSign,
    })
    const requestCode = () => app.inject({ method: 'POST', url: '/auth/otp', payload: { phone } })
    const codeCount = async () => (await app.db!.query('select id from otp_codes where phone=$1', [phone])).rowCount
    try {
      fetchMock.mockResolvedValueOnce(new Response(providerMessage))
      const failed = await requestCode()
      expect(failed.statusCode).toBe(502)
      expect(failed.json().error.code).toBe('sms_failed')
      expect(failed.body).not.toContain(providerMessage)
      expect(await codeCount()).toBe(0)

      fetchMock.mockResolvedValueOnce(Response.json({ success: true, data: [{ id: 1, status: 0 }] }))
      const retried = await requestCode()
      expect(retried.statusCode, retried.body).toBe(200)
      expect(await codeCount()).toBe(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      try {
        await app.db!.query('delete from otp_codes where phone=$1', [phone])
      } finally {
        await app.close()
      }
    }
  })
})
