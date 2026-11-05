import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { parseMediaStorage } from '../src/media/config.js'

const local = {
  NODE_ENV: 'test', MEDIA_S3_ENDPOINT: 'http://127.0.0.1:19001', MEDIA_S3_REGION: 'test-1',
  MEDIA_S3_BUCKET: 'private-media', MEDIA_S3_ACCESS_KEY: 'synthetic-access',
  MEDIA_S3_SECRET_KEY: 'synthetic-secret', MEDIA_DELIVERY_BASE_URL: 'https://app.example.test/api',
  MEDIA_SCAN_HOST: '127.0.0.1', MEDIA_SCAN_PORT: '19310',
}
describe('private media configuration admission', () => {
  it('positive control: still refuses a known invalid application port', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: 'invalid' })).toThrow(/PORT/)
  })
  it('keeps new uploads explicitly disabled when no media configuration exists', () => {
    expect(loadConfig({ NODE_ENV: 'test' })).toHaveProperty('mediaStorage', null)
  })
  it('refuses a partial media configuration instead of silently using ambient AWS credentials', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MEDIA_S3_ENDPOINT: local.MEDIA_S3_ENDPOINT })).toThrow(/MEDIA_/)
  })
  it('admits a complete explicit synthetic local configuration', () => {
    expect(loadConfig(local)).toHaveProperty('mediaStorage.endpoint', local.MEDIA_S3_ENDPOINT)
  })
  it.each(['http://169.254.169.254', 'https://user:password@s3.example.test', 'https://s3.example.test/?token=secret'])('rejects unsafe operator endpoint %s', endpoint => {
    expect(() => loadConfig({ ...local, MEDIA_S3_ENDPOINT: endpoint })).toThrow(/MEDIA_/)
  })
  it.each(['0', '1.5', '65536', 'NaN'])('rejects invalid scanner port %s', port => {
    expect(() => loadConfig({ ...local, MEDIA_SCAN_PORT: port })).toThrow(/MEDIA_/)
  })
  it('requires HTTPS for storage and delivery in production even on loopback', () => {
    const secure = { ...local, MEDIA_S3_ENDPOINT: 'https://objects.example.test' }
    expect(parseMediaStorage(secure, true)).toHaveProperty('endpoint', secure.MEDIA_S3_ENDPOINT)
    expect(() => parseMediaStorage(local, true)).toThrow(/MEDIA_S3_ENDPOINT/)
    expect(() => parseMediaStorage({ ...secure, MEDIA_DELIVERY_BASE_URL: 'http://localhost:3000/api' }, true)).toThrow(/MEDIA_DELIVERY_BASE_URL/)
  })
  it('rejects endpoint paths, URL credentials and query/fragment delivery URLs', () => {
    expect(() => parseMediaStorage({ ...local, MEDIA_S3_ENDPOINT: 'https://objects.example.test/another-bucket' }, false)).toThrow()
    for (const delivery of ['https://user:password@app.example.test/api', 'https://app.example.test/api?token=secret', 'https://app.example.test/api#secret']) {
      expect(() => parseMediaStorage({ ...local, MEDIA_DELIVERY_BASE_URL: delivery }, false)).toThrow(/MEDIA_DELIVERY_BASE_URL/)
    }
  })
  it('does not include secret values in configuration failures', () => {
    const secret = 'SYNTHETIC_PRIVATE_SECRET\ninvalid'
    const error = (() => { try { parseMediaStorage({ ...local, MEDIA_S3_SECRET_KEY: secret }, false) } catch (caught) { return caught } })()
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('MEDIA_S3_SECRET_KEY')
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_SECRET')
  })
})
