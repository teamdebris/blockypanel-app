# syntax=docker/dockerfile:1
# (for the cache mounts below; any Docker with BuildKit, the default since 23.0, has it)
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# The npm download cache and Next's build cache persist between builds on the same machine, so a
# rebuild after a small change (compose.build.yaml) skips most of the work.
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
# Only what the build needs, never the whole folder: an install can keep its data (worlds, backups,
# restic passwords, the account database) next to these files, under any folder name.
COPY package.json package-lock.json .npmrc next.config.ts tsconfig.json postcss.config.mjs proxy.ts instrumentation.ts ./
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public
COPY vendor ./vendor
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner
WORKDIR /app
# openssh-client and sshpass: SFTP offsite destinations (key or password sign-in).
RUN apk add --no-cache restic openssh-client sshpass
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV BLOCKY_STORAGE=/var/lib/blocky
RUN mkdir -p /var/lib/blocky
# The commit this image was built from, shown in the panel. Set by CI; empty for local builds.
ARG BLOCKY_BUILD=""
ENV BLOCKY_BUILD=${BLOCKY_BUILD}
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# 3000: the panel. 2022: SFTP for server files (BLOCKY_SFTP_PORT).
EXPOSE 3000 2022
# The panel runs as root on purpose: it hands world files to the Minecraft user (uid 1000) with
# chown, and restic restores file ownership only as root. Access to the mounted Docker socket is
# root-equivalent on the host regardless of the container user, so a non-root user here would not
# reduce what a compromise of the panel could do.
CMD ["node", "server.js"]
