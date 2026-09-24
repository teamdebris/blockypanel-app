import { isSafeSeed } from "./world.ts";
import { z } from "zod";

const MEMORY_OPTIONS = ["1G", "2G", "4G", "6G", "8G", "12G", "16G", "24G", "32G"] as const;

export const SERVER_TYPES = ["PAPER", "PURPUR", "VANILLA", "FABRIC", "QUILT", "FORGE", "NEOFORGE"] as const;
export const JAVA_VERSIONS = ["auto", "25", "21", "17", "11", "8"] as const;

// Keys the panel manages itself, or that would break backups (RCON) or the port mapping if overridden.
const managedPropertyKeys = new Set(["view-distance", "simulation-distance", "pause-when-empty-seconds"]);
const protectedPropertyKeys = new Set(["enable-rcon", "rcon.port", "rcon.password", "server-port", "enable-query", "query.port"]);

function propertyKeys(value: string) {
  return value.split("\n").filter((line) => line.trim()).map((line) => line.split("=", 1)[0].trim().toLowerCase());
}

const serverSchema = z.object({
  name: z.string().trim().min(2).max(60),
  type: z.enum(SERVER_TYPES),
  version: z.string().trim().min(1).max(30).regex(/^[a-zA-Z0-9._-]+$/),
  javaVersion: z.enum(JAVA_VERSIONS).default("auto"),
  memory: z.enum(MEMORY_OPTIONS),
  cpuLimit: z.number().min(0).max(64).multipleOf(0.25).default(0),
  port: z.number().int().min(1024).max(65535),
  difficulty: z.enum(["peaceful", "easy", "normal", "hard"]),
  maxPlayers: z.number().int().min(1).max(500),
  whitelist: z.array(z.string().trim().min(1).max(36).regex(/^[a-zA-Z0-9_-]+$/, "Whitelist entries must be usernames or UUIDs.")).max(100).default([]),
  seed: z.string().trim().max(64).refine(isSafeSeed, "The seed can't contain line breaks.").default(""),
  motd: z.string().trim().min(1).max(160).default("A Minecraft Server powered by Blocky"),
  customProperties: z.string().max(4000)
    .refine((value) => value.split("\n").every((line) => !line.trim() || line.includes("=")), "Custom properties must use key=value, one per line.")
    .refine((value) => propertyKeys(value).every((key) => !managedPropertyKeys.has(key)), "Use the dedicated performance controls for view distance, simulation distance, and idle pause.")
    .refine((value) => propertyKeys(value).every((key) => !protectedPropertyKeys.has(key)), "RCON, query, and server-port settings are managed by Blocky and cannot be overridden.")
    .default(""),
  initialMemoryPercent: z.number().int().min(5).max(90).default(25),
  maxMemoryPercent: z.number().int().min(25).max(90).default(75),
  rollingLogMaxFiles: z.number().int().min(1).max(1000).default(30),
  viewDistance: z.number().int().min(2).max(32).default(8),
  simulationDistance: z.number().int().min(2).max(32).default(6),
  stopAnnounceDelaySeconds: z.number().int().min(0).max(300).default(10),
  useMeowiceFlags: z.boolean().default(true),
  pauseWhenEmptySeconds: z.number().int().min(-1).max(86400).default(300),
  modrinthProjects: z.array(z.string().regex(/^[a-zA-Z0-9]{8}$/, "Invalid Modrinth project.")).max(100, "At most 100 plugins or mods.")
    .transform((ids) => [...new Set(ids)]).default([]),
  eula: z.literal(true),
});

const heapRange = {
  message: "Initial heap percentage cannot exceed the maximum heap percentage.",
  path: ["initialMemoryPercent"],
};

const distanceRange = {
  message: "Simulation distance can't be larger than view distance.",
  path: ["simulationDistance"],
};

export const createServerSchema = serverSchema.refine((value) => value.initialMemoryPercent <= value.maxMemoryPercent, heapRange).refine((value) => value.simulationDistance <= value.viewDistance, distanceRange);
export const updateServerSchema = serverSchema.omit({ eula: true }).refine((value) => value.initialMemoryPercent <= value.maxMemoryPercent, heapRange).refine((value) => value.simulationDistance <= value.viewDistance, distanceRange);

export const commandSchema = z.object({ command: z.string().trim().min(1).max(512).refine((value) => !/[\u0000\r\n]/.test(value), "Commands must be a single line.") });
export const actionSchema = z.object({ action: z.enum(["start", "stop", "restart", "backup", "update"]) });
export const backupNameSchema = z.string().regex(/^snapshot-[0-9a-f]{64}$/, "Invalid backup name.");
export const backupRestoreSchema = z.object({ name: backupNameSchema });
export const backupPolicySchema = z.object({ enabled: z.boolean(), intervalHours: z.number().int().min(1).max(168), retention: z.number().int().min(1).max(100) });
export const loginSchema = z.object({ username: z.string().trim().min(1, "Enter your username.").max(64), password: z.string().min(1, "Enter your password.").max(256), remember: z.boolean().optional() });
export const recoverySchema = z.object({ password: z.string().min(1, "Enter the recovery password.").max(256) });
export const setupSchema = z.object({ setupPassword: z.string().max(256).optional(), username: z.string().trim().max(64), password: z.string().max(256) });
export const acceptInviteSchema = z.object({ username: z.string().trim().max(64).optional(), password: z.string().max(256) });
export const changePasswordSchema = z.object({ current: z.string().max(256), password: z.string().max(256) });
const roleSchema = z.enum(["viewer", "operator", "admin"]);
export const inviteSchema = z.object({ role: roleSchema });
export const userUpdateSchema = z.object({ role: roleSchema.optional(), disabled: z.boolean().optional() });
export const userActionSchema = z.object({ action: z.enum(["reset-link", "sign-out"]) });
export const filePathSchema = z.string().max(1024);
export const fileDirectorySchema = z.object({ path: filePathSchema.min(1) });
export const fileRenameSchema = z.object({ from: filePathSchema.min(1), to: filePathSchema.min(1) });
export const fileWriteSchema = z.object({ path: filePathSchema.min(1), content: z.string().max(2 * 1024 * 1024) });

export { managedPropertyKeys };
export const rerollSchema = z.object({ seed: z.string().trim().max(64).refine(isSafeSeed, "The seed can't contain line breaks.").default("") });
