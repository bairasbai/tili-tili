import assert from 'node:assert/strict'

// Exact local retained test cluster ports. An override must be explicit;
// individual suites still enforce their own loopback/user/database fences.
export function disposablePgPort(): string {
  const port = process.env.TILI_DISPOSABLE_PG_PORT ?? '55432'
  assert(['55432', '15432'].includes(port), 'Only an explicitly selected local disposable PostgreSQL port is permitted')
  return port
}
