import { randomUUID } from 'node:crypto'
import type { MediaStorageConfig } from '../../src/media/config.js'

/** These tests issue local signatures only. Provider I/O is covered by managedMediaFixture. */
export function albumGrantConfig(): MediaStorageConfig {
  return {
    endpoint: 'https://objects.example.test', region: 'test-1', bucket: `test-album-${randomUUID()}`,
    accessKey: 'synthetic-test-access', secretKey: 'synthetic-test-secret', deliveryBaseUrl: 'https://app.example.test/api',
    scannerHost: '127.0.0.1', scannerPort: 9, postMaxSeconds: 60,
  }
}
