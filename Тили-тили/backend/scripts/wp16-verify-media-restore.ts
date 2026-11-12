import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { mediaStorageIdentity, parseMediaStorage } from '../src/media/config.js'
import { S3MediaStore, type MediaStore } from '../src/media/storage.js'

type ReadyObject = { id: string; storage_id: string; clean_key: string; output_bytes: number; sha256: string }

const PAGE_SIZE = 100

export async function verifyReadyObjects(db: Pick<pg.Client, 'query'>, store: Pick<MediaStore, 'read'>, storageId: string) {
  const report = { checked: 0, verified: 0, foreignNamespace: 0, unreadable: 0, invalidContent: 0 }
  let after: string | null = null
  for (;;) {
    const page: ReadyObject[] = (await db.query<ReadyObject>(`select id,storage_id,clean_key,output_bytes,sha256
      from media_uploads where state='ready' and ($1::uuid is null or id > $1::uuid) order by id limit $2`,
    [after, PAGE_SIZE])).rows
    for (const row of page) {
      report.checked++
      if (row.storage_id !== storageId) { report.foreignNamespace++; continue }
      let bytes: Buffer
      try { bytes = await store.read(row.clean_key, row.output_bytes) }
      catch { report.unreadable++; continue }
      if (bytes.length !== row.output_bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
        report.invalidContent++
        continue
      }
      report.verified++
    }
    if (page.length < PAGE_SIZE) return report
    after = page.at(-1)!.id
  }
}

async function main() {
  const connectionString = process.env.RESTORE_DATABASE_URL
  const config = parseMediaStorage(process.env, process.env.NODE_ENV === 'production')
  if (!connectionString || !config) throw new Error('Restore configuration is incomplete')

  const db = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 })
  const store = new S3MediaStore(config)
  try {
    await db.connect()
    await db.query('begin isolation level repeatable read read only')
    const report = await verifyReadyObjects(db, store, mediaStorageIdentity(config))
    await db.query('commit')
    process.stdout.write(JSON.stringify(report) + '\n')
    process.exitCode = report.checked === 0 ? 2 : Number(report.checked !== report.verified)
  } finally {
    store.close()
    await db.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ error: 'verification_unavailable' }))
    process.exitCode = 2
  })
}
