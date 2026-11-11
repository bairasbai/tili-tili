# syntax=docker/dockerfile:1
ARG NODE_IMAGE
ARG NGINX_IMAGE
FROM ${NODE_IMAGE} AS build
WORKDIR /repo/Тили-тили/app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
RUN printf 'minimum-release-age=0\n' > .npmrc
COPY Тили-тили/app/package.json Тили-тили/app/pnpm-lock.yaml ./
RUN --mount=type=cache,id=tili-local-web-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --node-linker=hoisted
COPY Тили-тили/app/ .
COPY Тили-тили/backend/src/orders/catalog.ts ../backend/src/orders/catalog.ts
COPY Тили-тили/backend/src/wedding/dates.ts ../backend/src/wedding/dates.ts
COPY Тили-тили/backend/src/errors.ts ../backend/src/errors.ts
RUN pnpm run build
FROM ${NGINX_IMAGE}
COPY --from=build /repo/Тили-тили/app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
RUN sed -i 's#http://api:3000/#http://127.0.0.1:3001/#' /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=5s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
