# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f examples/order-fulfillment/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @strand/sdk --filter @strand/example-order-fulfillment build
RUN pnpm --filter @strand/example-order-fulfillment --prod --legacy deploy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out ./
RUN addgroup -S strand && adduser -S strand -G strand
USER strand
ENV NODE_ENV=production
CMD ["node", "dist/worker.js"]
