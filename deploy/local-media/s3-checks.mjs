import { S3Client, CreateBucketCommand, HeadBucketCommand, GetBucketAclCommand, GetBucketPolicyCommand,
  GetBucketVersioningCommand, PutBucketTaggingCommand, GetBucketTaggingCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3'
import { requireLocal } from './common.mjs'
import { portfolioBucket } from './s3-policy.mjs'

export const status = error => error?.$metadata?.httpStatusCode
export function clientFor(env, credentials = { accessKeyId: env.MEDIA_S3_ACCESS_KEY, secretAccessKey: env.MEDIA_S3_SECRET_KEY }) {
  return new S3Client({ endpoint: env.MEDIA_S3_ENDPOINT, region: env.MEDIA_S3_REGION, forcePathStyle: true, maxAttempts: 1, credentials })
}
export function request(client, command) {
  return client.send(command, { abortSignal: AbortSignal.timeout(15_000) })
}

export async function checkPrivateBucket(client, identity, initialize = false) {
  const Bucket = portfolioBucket
  try { await request(client, new HeadBucketCommand({ Bucket })) }
  catch (error) {
    if (status(error) !== 404 || !initialize || identity.everReady) throw error
    await request(client, new CreateBucketCommand({ Bucket, ACL: 'private' }))
  }
  const acl = await request(client, new GetBucketAclCommand({ Bucket }))
  // This MinIO version returns an empty owner ID for the private ACL.
  requireLocal(acl.Owner?.ID === '' && acl.Grants?.length === 1
    && acl.Grants[0].Grantee?.Type === 'CanonicalUser' && acl.Grants[0].Grantee.ID === undefined
    && acl.Grants[0].Permission === 'FULL_CONTROL', 'LOCAL_BUCKET_NOT_PRIVATE')
  try { await request(client, new GetBucketPolicyCommand({ Bucket })); throw new Error('LOCAL_BUCKET_POLICY_EXISTS') }
  catch (error) { if (error.name !== 'NoSuchBucketPolicy') throw error }
  const versioning = await request(client, new GetBucketVersioningCommand({ Bucket }))
  requireLocal(versioning.Status === undefined, 'LOCAL_BUCKET_VERSIONING_UNSUPPORTED')
  let tags
  try { tags = (await request(client, new GetBucketTaggingCommand({ Bucket }))).TagSet }
  catch (error) { if (error.name !== 'NoSuchTagSet') throw error; tags = [] }
  if (tags?.some(tag => tag.Key === 'tili-local-instance' && tag.Value === identity.instance)) return
  requireLocal(initialize && !identity.everReady && tags?.length === 0, 'LOCAL_BUCKET_IDENTITY_MISMATCH')
  await request(client, new PutBucketTaggingCommand({ Bucket, Tagging: { TagSet: [{ Key: 'tili-local-instance', Value: identity.instance }] } }))
}

async function requireDenied(client, command, code) {
  try { await request(client, command) }
  catch (error) { if (status(error) === 403) return; throw error }
  throw new Error(code)
}

export async function checkSigner(env, previous) {
  const Bucket = portfolioBucket
  const app = clientFor(env)
  try {
    await request(app, new GetBucketLocationCommand({ Bucket }))
    await requireDenied(app, new GetBucketPolicyCommand({ Bucket }), 'LOCAL_S3_SIGNER_TOO_PRIVILEGED')
  } finally { app.destroy() }
  if (previous?.MEDIA_S3_ACCESS_KEY && previous.MEDIA_S3_SECRET_KEY) {
    const old = clientFor({ ...env, MEDIA_S3_ACCESS_KEY: previous.MEDIA_S3_ACCESS_KEY, MEDIA_S3_SECRET_KEY: previous.MEDIA_S3_SECRET_KEY })
    const rejection = previous.MEDIA_S3_ACCESS_KEY === env.MEDIA_S3_ACCESS_KEY ? 'SignatureDoesNotMatch' : 'InvalidAccessKeyId'
    try {
      try { await request(old, new GetBucketLocationCommand({ Bucket })) }
      catch (error) {
        requireLocal(status(error) === 403 && error.name === rejection, 'LOCAL_OLD_CREDENTIAL_REVOCATION_UNCONFIRMED')
        return rejection
      }
      throw new Error('LOCAL_OLD_CREDENTIAL_STILL_VALID')
    } finally { old.destroy() }
  }
  return null
}
