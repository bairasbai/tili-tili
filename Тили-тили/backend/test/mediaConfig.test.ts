import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { parseMediaStorage } from '../src/media/config.js'

const local = {
  NODE_ENV: 'test', MEDIA_S3_ENDPOINT: 'http://127.0.0.1:19001', MEDIA_S3_REGION: 'test-1',
  MEDIA_S3_BUCKET: 'private-media', MEDIA_S3_ACCESS_KEY: 'synthetic-access',
  MEDIA_S3_SECRET_KEY: 'synthetic-secret', MEDIA_DELIVERY_BASE_URL: 'https://app.example.test/api',
  MEDIA_SCAN_HOST: '127.0.0.1', MEDIA_SCAN_PORT: '19310', MEDIA_S3_POST_MAX_SECONDS: '60',
}
describe('private media configuration admission', () => {
  const unbounded = { ...local, MEDIA_DELIVERY_BASE_URL: 'http://127.0.0.1:43010/api',
    MEDIA_LOCAL_UNBOUNDED_POST: '1', MEDIA_S3_POST_MAX_SECONDS: '' }
  it('explicit local mode admits loopback without asserting a provider commit bound', () => {
    const config = loadConfig(unbounded).mediaStorage
    expect(config).toMatchObject({ localUnboundedPost: true, endpoint: local.MEDIA_S3_ENDPOINT })
    expect(config).not.toHaveProperty('postMaxSeconds')
  })
  it.each(['0', 'true', 'false', ' 1', '1 ', '\n'])('rejects malformed local opt-in even with otherwise disabled media: %j', flag => {
    expect(() => loadConfig({ NODE_ENV: 'test', MEDIA_LOCAL_UNBOUNDED_POST: flag })).toThrow(/MEDIA_LOCAL_UNBOUNDED_POST/)
  })
  it('forbids the local mode in production and alongside a finite bound', () => {
    expect(() => parseMediaStorage({ ...unbounded, MEDIA_S3_ENDPOINT: 'https://127.0.0.1',
      MEDIA_DELIVERY_BASE_URL: 'https://127.0.0.1/api' }, true)).toThrow(/MEDIA_LOCAL_UNBOUNDED_POST/)
    expect(() => parseMediaStorage({ ...unbounded, MEDIA_S3_POST_MAX_SECONDS: '60' }, false)).toThrow(/MEDIA_LOCAL_UNBOUNDED_POST/)
  })
  it.each([
    { MEDIA_S3_ENDPOINT: 'https://objects.example.test' },
    { MEDIA_DELIVERY_BASE_URL: 'https://app.example.test/api' },
    { MEDIA_SCAN_HOST: 'scanner' },
  ])('does not extend local mode to remote hosts: %j', changed => {
    expect(() => parseMediaStorage({ ...unbounded, ...changed }, false)).toThrow(/MEDIA_LOCAL_UNBOUNDED_POST/)
  })
  it('a local flag alone cannot turn on a partial provider, and an empty flag stays disabled', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', MEDIA_LOCAL_UNBOUNDED_POST: '1' })).toThrow(/MEDIA_/)
    expect(loadConfig({ NODE_ENV: 'test', MEDIA_LOCAL_UNBOUNDED_POST: '' }).mediaStorage).toBeNull()
  })
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
    expect(loadConfig(local)).toHaveProperty('mediaStorage.postMaxSeconds', 60)
  })
  it.each(['', '0', '61', '1.5', 'NaN'])('rejects absent/unbounded operator POST commit assertion %s', bound => {
    expect(() => loadConfig({ ...local, MEDIA_S3_POST_MAX_SECONDS: bound })).toThrow(/MEDIA_S3_POST_MAX_SECONDS/)
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
