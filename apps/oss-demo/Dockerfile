### Build stage — installs deps, builds the backend + the Angular frontend
FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

# Copy workspace manifests first for better layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY .npmrc ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile=false

# Build everything the runtime needs:
# - opendj-oss-demo (and its workspace deps via Turborepo `...` filter)
# - @opendj/frontend-template (Angular bundle served by oss-demo)
RUN pnpm --filter opendj-oss-demo... build
RUN pnpm --filter @opendj/frontend-template build

### Runtime stage
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY --from=build /repo /repo

# Stage the Angular bundle at a stable path so FRONTEND_DIST stays simple.
RUN mkdir -p /app/frontend-dist \
  && cp -R /repo/packages/frontend-template/dist/opendj-template/browser/. /app/frontend-dist/

# `serveStatic` resolves FRONTEND_DIST relative to process cwd — keep cwd
# fixed at /app so the relative path works regardless of how `start` was
# invoked.
WORKDIR /app
ENV FRONTEND_DIST=frontend-dist

EXPOSE 8888
# tsx handles workspace TS source + the `.js` import-specifier convention used
# by NodeNext/bundler module resolution. Cwd is /app so FRONTEND_DIST resolves.
CMD ["pnpm", "--filter", "opendj-oss-demo", "exec", "tsx", "/repo/apps/oss-demo/src/main.ts"]
