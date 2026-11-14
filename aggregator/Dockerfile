# syntax=docker/dockerfile:1.7
# Multi-stage: o runtime final leva só JS compilado + dependências de PRODUÇÃO + migrations.
# Nada de TypeScript, devDependencies, testes ou fontes na imagem que vai para produção.
ARG NODE_VERSION=22.23.5

# 1) Todas as dependências (inclui devDependencies para compilar)
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: o `prepare` (husky) não faz sentido dentro da imagem
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# 2) Compila TypeScript → dist/
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 3) Só dependências de produção (camada separada: muda menos que o código)
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# 4) Runtime enxuto, usuário não-root
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node package.json ./
USER node
EXPOSE 8000
# Liveness via fetch nativo do Node: a imagem alpine não precisa de curl/wget.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Node como PID 1 recebe o SIGTERM direto: o graceful shutdown (main.ts) drena e fecha tudo.
CMD ["node", "dist/main.js"]
