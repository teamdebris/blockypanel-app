FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:24-alpine AS builder
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
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
# openssh-client and sshpass: SFTP offsite destinations (key or password sign-in).
RUN apk add --no-cache restic openssh-client sshpass
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV BLOCKY_STORAGE=/var/lib/blocky
RUN mkdir -p /var/lib/blocky
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
# The panel runs as root on purpose: it hands world files to the Minecraft user (uid 1000) with
# chown, and restic restores file ownership only as root. Access to the mounted Docker socket is
# root-equivalent on the host regardless of the container user, so a non-root user here would not
# reduce what a compromise of the panel could do.
CMD ["node", "server.js"]
