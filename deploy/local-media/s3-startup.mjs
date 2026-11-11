import { requireLocal } from './common.mjs'

export async function provisionAndPublishS3(compose, hasS3Container) {
  await compose(['run', '--rm', '--no-deps', 'provision'], 'private')
  await compose(['stop', '--timeout', '30', 's3'], 'private')
  await compose(['rm', '--force', 's3'], 'private')
  requireLocal(!(await hasS3Container()), 'LOCAL_PRIVATE_S3_NOT_REMOVED')
  await compose(['up', '-d', '--wait', '--wait-timeout', '180', 's3'], 'public')
}
