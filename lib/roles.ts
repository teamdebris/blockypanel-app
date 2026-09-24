/**
 * Roles and the permission table. Pure: shared by the proxy (enforcement), the UI (what to show),
 * and tests (every API route must appear here).
 */
export const ROLES = ["viewer", "operator", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { viewer: "Viewer", operator: "Operator", admin: "Admin" };
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: "Sees servers, players, console output, backups, and activity. Can't change anything.",
  operator: "Also starts, stops, and restarts servers, sends console commands, and takes backups.",
  admin: "Full control, including settings, files, restores, deleting servers, and managing users.",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleAtLeast(role: Role | undefined, minimum: Role) {
  return role !== undefined && ROLES.indexOf(role) >= ROLES.indexOf(minimum);
}

/** "public" needs no session; a role needs a session with at least that role. */
export type Access = "public" | Role;

/**
 * Every API route and method. Anything missing is denied, so a new route is unreachable until it's
 * listed here (and a test fails until it is).
 */
export const API_ACCESS: Record<string, Partial<Record<string, Access>>> = {
  "/api/health": { GET: "public" },
  "/api/auth/login": { POST: "public" },
  // Public so an expired or revoked session can still clear its cookie.
  "/api/auth/logout": { POST: "public" },
  "/api/auth/setup": { GET: "public", POST: "public" },
  "/api/auth/recovery": { POST: "public" },
  "/api/auth/invite/[token]": { GET: "public", POST: "public" },
  "/api/auth/me": { GET: "viewer" },
  "/api/auth/password": { PUT: "viewer" },
  "/api/auth/sessions": { GET: "viewer", DELETE: "viewer" },
  "/api/users": { GET: "admin", POST: "admin" },
  "/api/users/[id]": { PATCH: "admin", DELETE: "admin", POST: "admin" },
  "/api/invites/[id]": { DELETE: "admin" },
  "/api/system": { GET: "viewer" },
  "/api/versions": { GET: "viewer" },
  "/api/servers": { GET: "viewer", POST: "admin" },
  "/api/servers/[id]": { PATCH: "admin", DELETE: "admin" },
  // "update" (a new image) is admin-only; the route checks that action itself.
  "/api/servers/[id]/actions": { POST: "operator" },
  "/api/servers/[id]/console": { POST: "operator" },
  "/api/servers/[id]/events": { GET: "viewer" },
  "/api/servers/[id]/logs/stream": { GET: "viewer" },
  // GET lists backups; POST restores one.
  "/api/servers/[id]/backups": { GET: "viewer", POST: "admin" },
  "/api/servers/[id]/backups/policy": { PUT: "admin" },
  "/api/servers/[id]/backups/[name]": { GET: "admin", DELETE: "admin" },
  "/api/servers/[id]/files": { GET: "admin", POST: "admin", PATCH: "admin", PUT: "admin", DELETE: "admin" },
  "/api/servers/[id]/reroll": { POST: "admin" },
  "/api/servers/[id]/modrinth": { GET: "viewer" },
  // Searching and compatibility checks serve installing, which is admin-only (a plugin is code on the server).
  "/api/servers/[id]/modrinth/search": { GET: "admin" },
  "/api/servers/[id]/modrinth/compatibility": { GET: "admin" },
  "/api/servers/[id]/offsite": { GET: "admin", POST: "admin" },
  "/api/offsite": { GET: "admin", PUT: "admin", PATCH: "admin", DELETE: "admin" },
  "/api/offsite/test": { POST: "admin" },
  "/api/offsite/copy": { POST: "admin" },
  "/api/offsite/ssh-key": { POST: "admin" },
  "/api/offsite/discover": { POST: "admin" },
  "/api/offsite/restore": { POST: "admin" },
  "/api/worlds": { GET: "admin" },
  "/api/worlds/[id]": { POST: "admin", DELETE: "admin" },
};

const compiled = Object.entries(API_ACCESS).map(([pattern, methods]) => ({
  regex: new RegExp(`^${pattern.replace(/\[[^\]]+\]/g, "[^/]+")}/?$`),
  methods,
}));

/** The access level for an API request, or undefined when it isn't allowed at all. */
export function apiAccess(pathname: string, method: string): Access | undefined {
  const route = compiled.find((item) => item.regex.test(pathname));
  return route?.methods[method === "HEAD" ? "GET" : method];
}

/** Pages: sign-in flows are public, user management and offsite backups are admin-only, everything else needs a session. */
export function pageAccess(pathname: string): Access {
  if (pathname === "/login" || pathname === "/setup" || pathname.startsWith("/invite/")) return "public";
  if (pathname === "/users" || pathname.startsWith("/users/") || pathname === "/backups") return "admin";
  return "viewer";
}

/** What each role may do in the UI. Mirrors API_ACCESS; the server enforces it regardless. */
export function capabilities(role: Role | undefined) {
  const operator = roleAtLeast(role, "operator");
  const admin = roleAtLeast(role, "admin");
  return {
    control: operator,       // start, stop, restart, backup now
    console: operator,       // send commands
    viewSettings: operator,
    manage: admin,           // create, delete, change settings, update image
    files: admin,
    restore: admin,          // restore, delete, download backups; schedule
    users: admin,
    offsite: admin,          // offsite backups: destination, passphrase, disaster recovery
  };
}
export type Capabilities = ReturnType<typeof capabilities>;
