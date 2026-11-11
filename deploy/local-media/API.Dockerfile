# syntax=docker/dockerfile:1
ARG NODE_IMAGE
ARG MC_IMAGE
FROM ${MC_IMAGE} AS minio-client
FROM ${NODE_IMAGE} AS backend
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
RUN printf 'minimum-release-age=0\n' > /app/.npmrc
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=tili-local-backend-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --node-linker=hoisted
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY --from=local . ./local-media
RUN pnpm run build

FROM backend AS provision
COPY --from=minio-client /usr/bin/mc /usr/local/bin/mc
ENTRYPOINT ["node", "/app/local-media/provision-s3.mjs"]

FROM backend AS runtime
USER node
CMD ["node", "/app/local-media/api.mjs"]
