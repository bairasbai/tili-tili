import type { Queryable } from '../src/plugins/db.js'
export interface SourceReference { path: string; sha256: string }
export interface SourceProof {
  kind: 'root_fr018_source85_complete_current_source_v1'
  checkout: string
  head: string
  integratedMain: string
  files: SourceReference[]
}
export interface Source85Admission {
  readonly filename: string
  readonly raw: string
  readonly head: string
  readonly targetName: string
  readonly targetURL: string
  readonly databaseOID: string
  readonly bundle: {
    kind: 'root_fr018_source85_closed_admission_v1'
    targetName: string
    targetURL: string
    databaseOID: string
    executionHead: string
    integratedMain: string
    creation: SourceReference
    schema: SourceReference
    source: SourceReference
  }
}
export interface NativeIdentity {
  name: string
  username: string
  port: number
  address: string
  oid: string
  encoding: string
}
export function readSource85Admission(): Source85Admission
export function verifySource85(admission: Source85Admission): { proof: SourceProof; raw: string }
export function inspectNative85(db: Queryable, admission: Source85Admission, applicationName: string): Promise<NativeIdentity>
