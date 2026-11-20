# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/server/Dockerfile .

FROM node:26-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @strand/sdk --filter @strand/server --filter @strand/dashboard build
# A self-contained copy of the server with only its production dependencies.
RUN pnpm --filter @strand/server --prod --legacy deploy /out

FROM node:26-alpine
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/dashboard/dist ./dashboard
RUN addgroup -S strand && adduser -S strand -G strand
USER strand
ENV NODE_ENV=production \
    PORT=4000 \
    DASHBOARD_DIR=/app/dashboard
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
