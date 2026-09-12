FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run prisma:generate && npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev --omit=optional

FROM base AS runner
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/ready').then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})"

CMD ["node", "dist/src/main.js"]
