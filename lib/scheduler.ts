import "server-only";
import { runScheduledBackups } from "@/lib/docker";

const schedulerGlobal = globalThis as typeof globalThis & { __blockyScheduler?: NodeJS.Timeout; __blockySchedulerRunning?: boolean };

async function tick() {
  // A first (full) backup of a large world can take longer than the tick interval; never overlap runs.
  if (schedulerGlobal.__blockySchedulerRunning) return;
  schedulerGlobal.__blockySchedulerRunning = true;
  try { await runScheduledBackups(); }
  catch (error) { console.error("Blocky scheduled backup check failed", error); }
  finally { schedulerGlobal.__blockySchedulerRunning = false; }
}

if (!schedulerGlobal.__blockyScheduler && process.env.BLOCKY_SCHEDULER !== "false") {
  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  schedulerGlobal.__blockyScheduler = timer;
  setTimeout(() => void tick(), 15_000).unref();
}
