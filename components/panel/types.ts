export type ServerStatus = "running" | "starting" | "stopped" | "failed";
export type ServerType = "PAPER" | "PURPUR" | "VANILLA" | "FABRIC" | "QUILT" | "FORGE" | "NEOFORGE";
export type JavaVersion = "auto" | "25" | "21" | "17" | "11" | "8";
export type Difficulty = "peaceful" | "easy" | "normal" | "hard";
export type GameMode = "survival" | "creative" | "adventure" | "spectator";

export type ServerConfig = {
  name: string; type: ServerType; version: string; javaVersion: JavaVersion; memory: string; cpuLimit: number;
  port: number; difficulty: Difficulty; maxPlayers: number;
  whitelist: string[]; seed: string; motd: string; customProperties: string;
  initialMemoryPercent: number; maxMemoryPercent: number; rollingLogMaxFiles: number;
  viewDistance: number; simulationDistance: number; stopAnnounceDelaySeconds: number;
  useMeowiceFlags: boolean; pauseWhenEmptySeconds: number;
  /** Modrinth project IDs the image installs into plugins/ or mods/ on start. */
  modrinthProjects: string[];
  gameMode: GameMode; pvp: boolean; hardcore: boolean; allowFlight: boolean; commandBlocks: boolean; onlineMode: boolean; spawnProtection: number;
};

export type ActiveOperation = { kind: string; label: string; step?: string; startedAt: string; actor?: string };
export type FinishedOperation = ActiveOperation & { ok: boolean; message: string; finishedAt: string };

export type MinecraftServer = ServerConfig & {
  id: string; status: ServerStatus; health: string; statusMessage: string; createdAt: string;
  cpuPercent: number; memoryUsageMb: number; memoryLimitMb: number; diskUsageBytes: number;
  playersOnline: number; players: string[]; backupCount: number; restartCount: number;
  operation?: ActiveOperation; lastOperation?: FinishedOperation;
  backup?: { enabled: boolean; intervalHours: number; lastRunAt?: string; consecutiveFailures: number };
  /** Present when offsite backups are on. */
  offsite?: { lastCopyAt?: string; lastError?: string };
  image?: string;
};

export type SystemState = { dockerAvailable: boolean; dockerVersion?: string; runningCount: number; serverCount: number; offsiteBackups?: boolean; publicHost?: string; error?: string; panel?: { version: string; commit?: string } };
export type Backup = { name: string; size: number; createdAt: string; kind: string; logicalSize?: number };
export type BackupPolicy = { enabled: boolean; intervalHours: number; retention: number; lastRunAt?: string };
export type BackupSchedule = { consecutiveFailures: number; lastAttemptAt?: string; lastFailure?: string; nextRunAt?: string };
export type OperationEvent = { id: string; at: string; type: string; level: "info" | "success" | "warning" | "error"; message: string; actor?: string };
export type ServerFileEntry = { name: string; path: string; type: "file" | "directory"; size: number; modifiedAt: string; editable: boolean };
export type DetachedWorld = { id: string; name: string; diskUsageBytes: number; hasData: boolean; hasBackups: boolean; canReattach: boolean };

export type ServerTab = "overview" | "console" | "plugins" | "backups" | "schedule" | "files" | "settings" | "activity";
export const SERVER_TABS: ServerTab[] = ["overview", "console", "plugins", "backups", "schedule", "files", "settings", "activity"];

export type NumericFormKey = "port" | "maxPlayers" | "cpuLimit" | "initialMemoryPercent" | "maxMemoryPercent" | "rollingLogMaxFiles" | "viewDistance" | "simulationDistance" | "stopAnnounceDelaySeconds" | "pauseWhenEmptySeconds" | "spawnProtection";
export type ServerForm = Omit<ServerConfig, NumericFormKey | "whitelist"> & Record<NumericFormKey, string> & { whitelist: string; eula?: boolean };
