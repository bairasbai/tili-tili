# syntax=docker/dockerfile:1
# Node 22 LTS — чётная ветка. Node 25 на машине разработчика ломает npm
# (ERR-0006), в образе этой проблемы нет.
FROM node:22-alpine AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Версия pnpm закреплена: corepack иначе тянет свежайшую, и она может читать
# лок-файл строже, чем та, которой он собран.
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
# pnpm по умолчанию отвергает пакеты, опубликованные несколько часов назад —
# защита от подменённой версии при интерактивной установке. Здесь установка
# идёт из закоммиченного лок-файла, версии в котором уже отобраны и проверены,
# а гейт превращается в «выкат невозможен сутки после релиза зависимости».
# Снимается ТОЛЬКО в образе: локально `pnpm add` защиту сохраняет.
RUN printf 'minimum-release-age=0\n' > /app/.npmrc

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --node-linker=hoisted
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --node-linker=hoisted
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
