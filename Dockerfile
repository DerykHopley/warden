# check=skip=SecretsUsedInArgOrEnv
# (the one build argument, Clerk's publishable key, is public by design: it ships in the page)

# Warden in one image: the built dashboard and the server that serves it with the API.
# The server runs its TypeScript directly on Node 24 (type stripping), so only the dashboard has a build step.

FROM node:24-slim AS base
# Corepack runs the pnpm version package.json's packageManager names, so there is one pin.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contracts/package.json contracts/
COPY server/package.json server/
COPY dashboard/package.json dashboard/

# The dashboard, built with Clerk's publishable key (public by design; the build fails without it).
FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY contracts contracts
COPY dashboard dashboard
ARG VITE_CLERK_PUBLISHABLE_KEY
RUN pnpm --filter @warden/dashboard build

# The server's production dependencies only.
FROM base AS deps
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter "@warden/server..."

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/contracts/node_modules contracts/node_modules
COPY --from=deps /app/server/node_modules server/node_modules
COPY package.json ./
COPY contracts/package.json contracts/
COPY contracts/src contracts/src
COPY server/package.json server/
COPY server/src server/src
# The release runs `node server/src/migrate.ts` from the image, so the migrations ship with it.
COPY server/migrations server/migrations
COPY --from=build /app/dashboard/dist dashboard/dist
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/src/index.ts"]
