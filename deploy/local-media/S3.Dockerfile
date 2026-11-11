ARG S3_IMAGE
ARG NODE_IMAGE
FROM ${S3_IMAGE} AS provider
FROM ${NODE_IMAGE}
COPY --from=provider /usr/bin/minio /usr/local/bin/minio
COPY s3.mjs s3-credentials.mjs s3-policy.mjs common.mjs /local-media/
ENTRYPOINT ["node", "/local-media/s3.mjs"]
