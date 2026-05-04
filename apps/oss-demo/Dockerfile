### Build stage — installs deps, builds the backend + the Angular frontend
FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# `git` for lefthook's postinstall + the root `prepare` (`lefthook install`).
# `python3 make g++` for argon2's native build (Argon2id password hasher).
RUN apk add --no-cache git python3 make g++ \
  && corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

# Copy workspace manifests first for better layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY .npmrc ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# `git init` so lefthook's `prepare` script has a repo to attach hooks to.
# We never push from the container — this is purely to keep the install happy.
RUN git init -q . && pnpm install --frozen-lockfile=false

# Build everything the runtime needs:
# - opendj-oss-demo (and its workspace deps via Turborepo `...` filter)
# - @opendj/frontend-template (Angular bundle served by oss-demo)
RUN pnpm --filter opendj-oss-demo... build
RUN pnpm --filter @opendj/frontend-template build

### Runtime stage
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# argon2 binds native code at runtime; alpine needs libstdc++/libc to load it.
# `git` not needed at runtime (lefthook only runs at install time).
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Carry the entire built workspace forward so `pnpm` can resolve workspace
# dependencies via the on-disk pnpm store at /repo/node_modules.
COPY --from=build /repo /repo

# Run the app from inside the oss-demo package so `pnpm exec` finds the
# nearest workspace and tsx resolves /repo/* via the local node_modules.
WORKDIR /repo/apps/oss-demo

EXPOSE 8888
# `tsx src/main.ts` matches the `start` script. The Angular bundle path
# defaults to packages/frontend-template/dist/opendj-template/browser
# resolved against the repo root (computed from import.meta.url), so no
# FRONTEND_DIST override needed.
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
