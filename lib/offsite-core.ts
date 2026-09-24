/**
 * Pure helpers for offsite backups: destination types, repository locations, input rules, and the
 * index format. Shared by the server, the UI, and tests.
 *
 * Layout at a destination:
 *   index/           restic repository with one JSON document: every server's ID, name, and
 *                    repository password. Opens with the panel's own key or the backup passphrase.
 *   servers/<id>/    one restic repository per server (world snapshots + settings snapshots),
 *                    using the same password as the server's local repository.
 */

export type S3Provider = "b2" | "r2" | "wasabi" | "aws" | "minio" | "other";

export type OffsiteDestination =
  | { kind: "s3"; provider: S3Provider; endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey?: string }
  | { kind: "folder"; path: string }
  | { kind: "sftp"; host: string; port: number; user: string; path: string; auth: "password" | "key"; password?: string; privateKey?: string; publicKey?: string; hostKey?: string; hostFingerprints?: string[] };

/** One line naming a destination, e.g. "Backblaze B2 · my-worlds/blocky". */
export function describeDestination(destination: OffsiteDestination) {
  if (destination.kind === "folder") return `Folder ${destination.path}`;
  if (destination.kind === "sftp") return `SFTP ${destination.user}@${destination.host}${destination.port === 22 ? "" : `:${destination.port}`}:${destination.path}`;
  const provider = S3_PROVIDERS.find((item) => item.value === destination.provider)?.label || "S3";
  return `${provider} · ${joinPath(destination.bucket, destination.prefix)}`;
}

export const S3_PROVIDERS: { value: S3Provider; label: string; needsEndpoint: boolean; regionHint: string }[] = [
  { value: "b2", label: "Backblaze B2", needsEndpoint: false, regionHint: "us-west-004" },
  { value: "r2", label: "Cloudflare R2", needsEndpoint: true, regionHint: "auto" },
  { value: "wasabi", label: "Wasabi", needsEndpoint: false, regionHint: "us-east-1" },
  { value: "aws", label: "Amazon S3", needsEndpoint: false, regionHint: "us-east-1" },
  { value: "minio", label: "MinIO (self-hosted)", needsEndpoint: true, regionHint: "us-east-1" },
  { value: "other", label: "Other S3-compatible", needsEndpoint: true, regionHint: "" },
];

/** The S3 endpoint, from a provider preset or the one entered. http(s):// is kept only when given. */
export function s3Endpoint(destination: Extract<OffsiteDestination, { kind: "s3" }>) {
  switch (destination.provider) {
    case "b2": return `s3.${destination.region}.backblazeb2.com`;
    case "wasabi": return `s3.${destination.region}.wasabisys.com`;
    case "aws": return `s3.${destination.region}.amazonaws.com`;
    case "r2": return destination.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    default: return destination.endpoint.replace(/\/+$/, "");
  }
}

function joinPath(...parts: string[]) {
  return parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

/**
 * The restic repository string for the index or a server. `folderRoot` replaces a folder
 * destination's path when restic runs in a helper container that mounts it elsewhere.
 */
export function repositoryFor(destination: OffsiteDestination, part: "index" | { server: string }, folderRoot?: string) {
  const sub = part === "index" ? "index" : joinPath("servers", part.server);
  if (destination.kind === "s3") {
    const endpoint = s3Endpoint(destination);
    const base = /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;
    return `s3:${base}/${joinPath(destination.bucket, destination.prefix, sub)}`;
  }
  if (destination.kind === "sftp") return `sftp:${destination.user}@${destination.host}:/${joinPath(destination.path, sub)}`;
  const root = folderRoot || destination.path;
  // A Windows drive path only when developing on Windows; real folder destinations are Linux paths.
  if (/^[A-Za-z]:[\\/]/.test(root)) return `${root.replace(/[\\/]+$/, "")}/${sub}`;
  return `/${joinPath(root, sub)}`;
}

const SYSTEM_FOLDERS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var/run", "/var/lib/docker"];

/** Why a folder can't be a backup destination, or null. The existence check happens on the host. */
export function folderPathProblem(path: string, storageRoot: string) {
  if (!path.startsWith("/")) return "Use an absolute path, like /mnt/backup.";
  if (path.split("/").some((part) => part === ".." || part === ".")) return "The path can't contain . or .. parts.";
  const clean = `/${joinPath(path)}`;
  if (clean === "/") return "Choose a folder, not the whole filesystem.";
  if (SYSTEM_FOLDERS.some((folder) => clean === folder || clean.startsWith(`${folder}/`))) return "That's a system folder. Use a dedicated disk or folder, like /mnt/backup.";
  const root = `/${joinPath(storageRoot)}`;
  if (clean === root || clean.startsWith(`${root}/`) || root.startsWith(`${clean}/`)) return "Offsite backups must live outside Blocky's own folder, or they share its fate.";
  return null;
}

export const PASSPHRASE_MIN_LENGTH = 20;
export const PASSPHRASE_MIN_WORDS = 5;

/** The passphrase is the only way in on another machine and can't be reset, so it must be strong. */
export function passphraseProblem(passphrase: string) {
  const words = passphrase.trim().split(/[\s-]+/).filter((word) => word.length >= 3);
  if (passphrase.length >= PASSPHRASE_MIN_LENGTH || words.length >= PASSPHRASE_MIN_WORDS) return null;
  return `Use at least ${PASSPHRASE_MIN_WORDS} words or ${PASSPHRASE_MIN_LENGTH} characters.`;
}

/** The secret values in a destination, for scrubbing error messages. */
export function secretsOf(destination: OffsiteDestination) {
  if (destination.kind === "s3") return destination.secretAccessKey ? [destination.secretAccessKey] : [];
  if (destination.kind === "sftp") return [destination.password, destination.privateKey].filter((value): value is string => Boolean(value));
  return [];
}

export function scrubSecrets(message: string, secrets: string[]) {
  return secrets.filter((secret) => secret.length >= 4).reduce((text, secret) => text.split(secret).join("[hidden]"), message);
}

export type OffsiteIndexEntry = { name: string; type: string; version: string; repositoryPassword: string; lastCopyAt: string; removed?: boolean };
export type OffsiteIndex = { version: 1; panelId: string; updatedAt: string; servers: Record<string, OffsiteIndexEntry> };

const SERVER_ID = /^[a-zA-Z0-9-]{1,64}$/;

export function serializeIndex(index: OffsiteIndex) {
  return JSON.stringify(index);
}

export function parseIndex(text: string): OffsiteIndex {
  const data = JSON.parse(text) as OffsiteIndex;
  if (data?.version !== 1 || typeof data.panelId !== "string" || typeof data.servers !== "object" || !data.servers) throw new Error("The offsite index isn't in a format this panel understands.");
  for (const [id, entry] of Object.entries(data.servers)) {
    if (!SERVER_ID.test(id) || typeof entry?.repositoryPassword !== "string" || typeof entry.name !== "string") throw new Error("The offsite index has a malformed server entry.");
  }
  return data;
}
