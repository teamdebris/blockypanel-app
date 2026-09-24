# How Blocky Panel is built

A Next.js (App Router) app that manages Minecraft servers as Docker containers, one container per server, using the [`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server) image. There's no separate backend service: route handlers talk to Docker through the socket with `dockerode`.

## Where things live

| Path | What it does |
|---|---|
| `lib/docker.ts` | The server lifecycle: create, update (safety backup, recreate, health check, automatic rollback), start/stop/restart, backups and restores, world re-roll, the console, player counts, and the demo mode's fake Docker. |
| `lib/incremental-backups.ts` | restic: snapshots, restores, downloads (`restic dump`), retention, integrity checks, offsite copies. |
| `lib/files.ts` | The file manager, confined to each server's `data/` folder. Never follows symlinks. |
| `lib/modrinth-core.ts`, `lib/modrinth.ts` | Plugin and mod search, and identifying installed jars by hash. The image does the installing (`MODRINTH_PROJECTS`). |
| `lib/world.ts` | Pure helpers for re-rolling a world (folder names, the seed line). |
| `lib/account-store.ts` | Users, invites, reset links, sessions, and the account audit log in SQLite (`node:sqlite`). No Next.js imports, so tests run it on `:memory:`. |
| `lib/auth.ts`, `lib/auth-server.ts`, `lib/session.ts`, `lib/passwords.ts` | Opening the account database, the signed-in user, session cookies, the recovery password, scrypt hashing. |
| `lib/roles.ts` | Roles and `API_ACCESS`: every API route and method with its minimum role. |
| `proxy.ts` | Runs before every request: origin and CSRF-header checks, then the permission table; redirects to `/setup` until an admin exists. |
| `lib/rate-limit.ts` | Sign-in throttling. |
| `lib/store.ts` | `panel/control-state.json`: backup schedules, schedule health, and the per-server activity log. |
| `lib/operations.ts` | Background operations with one lock per server, and their progress shown in the UI. |
| `lib/scheduler.ts`, `lib/schedule.ts`, `lib/retention.ts` | Scheduled backups, retry backoff, and which snapshots to keep. |
| `lib/paths.ts` | Every storage path. Built with `storagePath()` so the build's file tracer can't copy data into the output (see below). |
| `app/api/**` | Route handlers. Each must be listed in `API_ACCESS`. |
| `components/panel/**` | The panel UI. `panel-context.tsx` polls the API and holds the signed-in user and what their role may do. |
| `components/ui/**` | shadcn/ui components, kept as generated. |

## Conventions and gotchas

- **The server's configuration lives in Docker labels** (`panel.*`), with a copy in each server's `server.json` so a removed server can be reattached. There's no database of servers; the container list is the source of truth.
- **Access control is deny-by-default.** A new route is unreachable until it's added to `API_ACCESS` in `lib/roles.ts`, and `tests/accounts.test.ts` fails if a route file exists without an entry. Checks that depend on the request body, like the admin-only `update` action, happen in the handler.
- **Tests use Node's built-in runner** (`npm test`) and import `lib/*.ts` directly with type stripping. So the pure modules use relative `.ts` imports and no constructor parameter properties.
- **`AccountError` is matched by name, not `instanceof`,** in `lib/responses.ts`: relative and `@/` imports can put two copies of the class in the bundle.
- **Storage paths go through `storagePath()`.** Next's tracer follows `path.join` statically and copies whatever it could point to into `.next/standalone`; with an install living in the project folder, that included worlds and restic passwords. The Dockerfile's builder stage also copies an allowlist of files for the same reason.
- **Commands never start with `-`.** `rcon-cli` reads options anywhere in its arguments.
- **Symlinks inside server folders are never followed.** The Minecraft container can write there.

## Running it

- `npm run dev`: development on localhost. `BLOCKY_DEMO=true` runs without Docker, with sample servers and admin/operator/viewer users (password `blocky-demo`).
- `npm test`, `npx tsc --noEmit -p .`, `npm run lint`, and `npm run build`: what to run before a pull request.
