# Stage 1: Builder
FROM node:22.23.4-slim AS builder
WORKDIR /app
# pnpm pinned to 9 (lockfile v9): pnpm 12 ignores package.json pnpm.overrides,
# fails --frozen-lockfile and the fallback install drops the security overrides.
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY . .
RUN pnpm build

# Stage 2: Production
FROM node:22.23.4-slim
WORKDIR /app
# pnpm pinned to 9 (lockfile v9): pnpm 12 ignores package.json pnpm.overrides,
# fails --frozen-lockfile and the fallback install drops the security overrides.
RUN npm install -g pnpm@9
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/openapi.json ./openapi.json
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
