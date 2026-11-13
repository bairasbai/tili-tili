import { requireLocal } from './common.mjs'

// Called only after the launcher has stopped the old API and S3 processes,
// rotated the signing key, and drained the old database connections.
export async function retireLocalMediaObjects(db, storageId, removeConfirmed) {
  const protectReady = `not exists(select 1 from media_uploads a
    where a.clean_key=o.key and a.storage_id=o.storage_id and a.state='ready')`
  await db.query("update media_uploads set state='expired',nonce=null,lease_until=null where storage_id=$1 and state not in ('ready','deleted','expired')", [storageId])
  const candidates = (await db.query(`select o.key,o.obligation_version,o.state,o.write_phase,o.writer_nonce from media_objects o
    where o.storage_id=$1 and o.state<>'done' and ${protectReady} order by o.key`, [storageId])).rows
  for (const object of candidates) {
    await removeConfirmed(object.key)
    const result = await db.query(`update media_objects o set state='done',nonce=null,lease_until=null,last_error=null,
      write_phase=case when write_phase in ('inflight','uncertain') then 'settled' else write_phase end,
      obligation_version=obligation_version+1,updated_at=clock_timestamp()
      where key=$1 and storage_id=$2 and obligation_version=$3 and state=$4 and write_phase=$5 and writer_nonce is not distinct from $6
      and ${protectReady}`, [object.key, storageId, object.obligation_version, object.state, object.write_phase, object.writer_nonce])
    requireLocal(result.rowCount === 1, 'LOCAL_RETIREMENT_CAS_FAILED')
  }
  return candidates.length
}
