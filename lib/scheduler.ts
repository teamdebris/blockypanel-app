import "server-only";
import { runScheduledBackups, runScheduledTasks } from "@/lib/docker";
import { runOffsiteSchedule } from "@/lib/offsite";

const schedulerGlobal = globalThis as typeof globalThis & { __blockyScheduler?: NodeJS.Timeout; __blockySchedulerRunning?: boolean; __blockyOffsiteRunning?: boolean; __blockyTasksRunning?: boolean };

async function tick() {
  // A first (full) backup of a large world can take longer than the tick interval; never overlap runs.
  if (schedulerGlobal.__blockySchedulerRunning) return;
  schedulerGlobal.__blockySchedulerRunning = true;
  try { await runScheduledBackups(); }
  catch (error) { console.error("Blocky scheduled backup check failed", error); }
  finally { schedulerGlobal.__blockySchedulerRunning = false; }
}

// Offsite copies run on their own loop, so a long upload never delays local backups.
async function offsiteTick() {
  if (schedulerGlobal.__blockyOffsiteRunning) return;
  schedulerGlobal.__blockyOffsiteRunning = true;
  try { await runOffsiteSchedule(); }
  catch (error) { console.error("Blocky offsite schedule check failed", error); }
  finally { schedulerGlobal.__blockyOffsiteRunning = false; }
}

// Scheduled tasks too: a first backup of a large world can take many minutes.
async function tasksTick() {
  if (schedulerGlobal.__blockyTasksRunning) return;
  schedulerGlobal.__blockyTasksRunning = true;
  try { await runScheduledTasks(); }
  catch (error) { console.error("Blocky scheduled task check failed", error); }
  finally { schedulerGlobal.__blockyTasksRunning = false; }
}

if (!schedulerGlobal.__blockyScheduler && process.env.BLOCKY_SCHEDULER !== "false") {
  const timer = setInterval(() => { void tick(); void offsiteTick(); void tasksTick(); }, 60_000);
  timer.unref();
  schedulerGlobal.__blockyScheduler = timer;
  setTimeout(() => void tick(), 15_000).unref();
}
