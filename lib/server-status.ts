/**
 * A server's status from its container's state. Pure, so it's shared by lib/docker.ts and tests.
 *
 * A stopped container only counts as failed when it stopped on its own. The panel's own stops
 * (the Stop button, updates, restores, scheduled restarts) end with whatever code Minecraft or
 * Docker leaves (often 143, or 137 when it took too long to shut down), so the panel remembers when
 * it stopped a server and treats that as a clean stop. Health only means something while the
 * container runs: Docker keeps the last health result after a stop, which is usually "unhealthy"
 * because the check fails while Minecraft shuts down.
 */

export type ServerStatus = "running" | "starting" | "stopped" | "failed";

export type ContainerFacts = {
  /** Docker's container state: running, created, restarting, exited, dead, paused. */
  state: string;
  /** Docker's health status while running: starting, healthy, unhealthy, or undefined without a check. */
  health?: string;
  exitCode?: number;
  oomKilled?: boolean;
  /** When the container last started (ISO). */
  startedAt?: string;
  /** When the panel last stopped this server on purpose (ISO). */
  panelStoppedAt?: string;
};

/** Whether the panel stopped the container during its current run. */
export function stoppedByPanel(facts: Pick<ContainerFacts, "startedAt" | "panelStoppedAt">) {
  if (!facts.panelStoppedAt) return false;
  const stopped = Date.parse(facts.panelStoppedAt);
  const started = facts.startedAt ? Date.parse(facts.startedAt) : Number.NaN;
  return Number.isFinite(stopped) && (!Number.isFinite(started) || stopped >= started);
}

export function serverStatus(facts: ContainerFacts): ServerStatus {
  if (facts.state === "running") {
    if (facts.health === "starting") return "starting";
    if (facts.health === "unhealthy") return "failed";
    return "running";
  }
  if (facts.state === "created" || facts.state === "restarting") return "starting";
  if (facts.state === "exited" || facts.state === "dead") {
    if (facts.oomKilled) return "failed";
    // 0 is a clean exit, and 143 (SIGTERM) means something asked it to stop: `docker stop`, a host
    // shutdown. 137 (SIGKILL) is also what a stop that took too long ends with, so only the panel's
    // own record makes that one clean.
    if (facts.exitCode === 0 || facts.exitCode === 143 || stoppedByPanel(facts)) return "stopped";
    return "failed";
  }
  return "stopped";
}

/** The health to show: Docker's while running, otherwise just "stopped". */
export function serverHealth(facts: Pick<ContainerFacts, "state" | "health">) {
  if (facts.state !== "running") return "stopped";
  return facts.health || "running";
}

/** Restarts in a row, with the same setup error each time, before the panel stops the loop. */
export const STARTUP_LOOP_RESTARTS = 2;

/**
 * The setup error that ended the container's last run, if it was one that will happen again on every
 * try: the image's helper rejecting its settings, like a Modrinth project with no file for this loader
 * and Minecraft version. Docker's restart policy would retry forever, so the panel stops the server
 * instead. Network errors aren't matched: those can clear up on their own.
 */
export function startupSetupError(logs: string) {
  const text = logs.replace(/\x1b\[[0-9;]*m/g, "");
  // Docker's log holds earlier runs too; only the last one counts.
  const lastRun = text.slice(Math.max(0, text.lastIndexOf("[init] Running as")));
  const match = [...lastRun.matchAll(/ERROR\s*:\s*Invalid parameter provided for '([\w-]+)' command:\s*(.+)/g)].at(-1);
  if (!match) return undefined;
  return { command: match[1], message: match[2].trim() };
}
