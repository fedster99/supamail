FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --filter @supamail/api... --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @supamail/api build

FROM node:24-slim AS runner
ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --filter @supamail/api --prod --frozen-lockfile=false
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/supabase ./apps/api/supabase
WORKDIR /app/apps/api
CMD ["node", "dist/runtime.js"]
