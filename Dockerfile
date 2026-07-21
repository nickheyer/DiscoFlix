# syntax=docker/dockerfile:1

# ---- PROD DEPS ONLY (NO devDependencies, NO PRISMA CLI) ----
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# THE PRISMA CLI + SCHEMA ENGINE (~60MB) ARE USELESS AT RUNTIME - MIGRATIONS
# RUN IN-PROCESS VIA src/core/migrate.js AGAINST THE GENERATED CLIENT
RUN npm ci --omit=dev && npm cache clean --force \
 && rm -rf node_modules/prisma node_modules/@prisma/engines node_modules/.bin/prisma

# ---- PRISMA CLIENT GENERATION (CLI COMES FROM devDependencies) ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npx prisma generate

# ---- RUNTIME ----
FROM node:26-alpine
LABEL org.opencontainers.image.source="https://github.com/nickheyer/DiscoFlix" \
      org.opencontainers.image.description="DiscoFlix - Discord media request bot + web console" \
      org.opencontainers.image.licenses="ISC"

# PRISMA'S musl QUERY ENGINE LINKS AGAINST SHARED OPENSSL
RUN apk add --no-cache openssl

ENV NODE_ENV=production \
    PORT=5001 \
    DF_DATA_DIR=/data

WORKDIR /app
RUN addgroup -S discoflix && adduser -S discoflix -G discoflix \
 && mkdir -p /data && chown discoflix:discoflix /data /app

COPY --from=deps --chown=discoflix:discoflix /app/node_modules ./node_modules
# GENERATED CLIENT + QUERY ENGINE LAND IN node_modules/.prisma
COPY --from=build --chown=discoflix:discoflix /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=discoflix:discoflix package.json logging.js ./
COPY --chown=discoflix:discoflix prisma/schema.prisma ./prisma/schema.prisma
COPY --chown=discoflix:discoflix prisma/migrations ./prisma/migrations
COPY --chown=discoflix:discoflix public ./public
COPY --chown=discoflix:discoflix src ./src

USER discoflix
EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||5001)+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

# MIGRATIONS RUN IN-PROCESS AT BOOT (src/core/migrate.js) - NO ENTRYPOINT NEEDED
CMD ["node", "src/server/server.js"]
