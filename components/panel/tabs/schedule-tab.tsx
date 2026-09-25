"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, MessageSquare, MoreHorizontal, Pencil, Play, Plus, RotateCcw, TerminalSquare, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { describeSchedule, type ScheduledTask, type TaskKind, WEEKDAYS } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field, Section } from "../common";
import { api, ApiError, errorMessage, formatDate, formatRelative } from "../lib";
import { useNow, usePanel } from "../panel-context";
import type { MinecraftServer } from "../types";

type Task = ScheduledTask & { nextRunAt?: string };
type Draft = { kind: TaskKind; type: "daily" | "interval"; time: string; days: number[]; timeZone: string; hours: string; command: string; message: string; warnMinutes: string };

const kinds: { value: TaskKind; label: string; hint: string; icon: typeof RotateCcw }[] = [
  { value: "restart", label: "Restart", hint: "Warns players in chat first", icon: RotateCcw },
  { value: "command", label: "Command", hint: "Runs a console command", icon: TerminalSquare },
  { value: "broadcast", label: "Message", hint: "Says something in chat", icon: MessageSquare },
];

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function draftFrom(task?: Task): Draft {
  const base: Draft = { kind: "restart", type: "daily", time: "04:00", days: [], timeZone: browserTimeZone(), hours: "6", command: "", message: "", warnMinutes: "5" };
  if (!task) return base;
  return {
    ...base, kind: task.kind, command: task.command || "", message: task.message || "", warnMinutes: String(task.warnMinutes ?? 5),
    ...(task.schedule.type === "daily" ? { type: "daily", time: task.schedule.time, days: task.schedule.days, timeZone: task.schedule.timeZone } : { type: "interval", hours: String(task.schedule.hours) }),
  };
}

function payload(draft: Draft, enabled: boolean) {
  return {
    kind: draft.kind, enabled, warnMinutes: Number(draft.warnMinutes || 0),
    schedule: draft.type === "daily" ? { type: "daily", time: draft.time, days: draft.days, timeZone: draft.timeZone } : { type: "interval", hours: Number(draft.hours) },
    ...(draft.kind === "command" ? { command: draft.command } : {}),
    ...(draft.kind === "broadcast" ? { message: draft.message } : {}),
  };
}

function what(task: ScheduledTask) {
  if (task.kind === "restart") return task.warnMinutes ? `Restart, warning players ${task.warnMinutes} min before` : "Restart";
  if (task.kind === "command") return <>Run <span className="font-mono">/{task.command}</span></>;
  return <>Say &ldquo;{task.message}&rdquo;</>;
}

function TaskDialog({ server, task, open, onOpenChange, onSaved }: { server: MinecraftServer; task?: Task; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(task));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (values: Partial<Draft>) => setDraft({ ...draft, ...values });
  async function save() {
    setBusy(true); setErrors({});
    try {
      const body = JSON.stringify(payload(draft, task?.enabled ?? true));
      if (task) await api(`/api/servers/${server.id}/tasks/${task.id}`, { method: "PATCH", body });
      else await api(`/api/servers/${server.id}/tasks`, { method: "POST", body });
      toast.success(task ? "Task saved." : "Task scheduled.");
      onOpenChange(false);
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.field) setErrors({ [error.field.split(".").at(-1)!]: error.message });
      else toast.error(errorMessage(error, "Couldn't save the task."));
    } finally { setBusy(false); }
  }
  const toggleDay = (day: number) => set({ days: draft.days.includes(day) ? draft.days.filter((item) => item !== day) : [...draft.days, day] });
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>{task ? "Edit task" : "Schedule a task"}</DialogTitle><DialogDescription>Runs automatically while {server.name} is running. Stopped servers are left alone.</DialogDescription></DialogHeader>
      <div className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Task">
          {kinds.map((item) => <button key={item.value} type="button" role="radio" aria-checked={draft.kind === item.value} onClick={() => set({ kind: item.value })}
            className={cn("rounded-xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", draft.kind === item.value ? "border-foreground/50 bg-accent" : "border-border hover:border-foreground/30")}>
            <item.icon className="size-4" /><span className="mt-1.5 block text-sm font-medium">{item.label}</span><span className="block text-xs text-muted-foreground">{item.hint}</span>
          </button>)}
        </div>
        {draft.kind === "command" && <Field label="Command" id="task-command" error={errors.command} hint="Without the slash, like save-all or weather clear.">{(props) => <Input {...props} value={draft.command} onChange={(event) => set({ command: event.target.value })} className="font-mono" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={512} />}</Field>}
        {draft.kind === "broadcast" && <Field label="Message" id="task-message" error={errors.message} hint="Shown in chat to everyone online.">{(props) => <Input {...props} value={draft.message} onChange={(event) => set({ message: event.target.value })} maxLength={200} />}</Field>}
        {draft.kind === "restart" && <Field label="Warn players" id="task-warn" error={errors.warnMinutes} hint="Minutes of countdown messages in chat first, when anyone is online. 0 restarts right away.">{(props) => <div className="flex items-center gap-2"><Input {...props} type="number" min={0} max={30} value={draft.warnMinutes} onChange={(event) => set({ warnMinutes: event.target.value })} className="w-24" /><span className="text-sm text-muted-foreground">minutes</span></div>}</Field>}
        <div className="space-y-3">
          <div className="inline-flex rounded-lg border border-border p-1" role="radiogroup" aria-label="When">
            {(["daily", "interval"] as const).map((type) => <button key={type} type="button" role="radio" aria-checked={draft.type === type} onClick={() => set({ type })} className={cn("rounded-md px-3 py-1.5 text-xs", draft.type === type ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>{type === "daily" ? "At a time of day" : "Every few hours"}</button>)}
          </div>
          {draft.type === "daily" ? <>
            <Field label="Time" id="task-time" error={errors.time} hint={`In ${draft.timeZone}.`}>{(props) => <Input {...props} type="time" value={draft.time} onChange={(event) => set({ time: event.target.value })} className="w-32" required />}</Field>
            <div className="field">
              <span className="text-sm font-medium">Days</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
                {WEEKDAYS.map((label, day) => <button key={label} type="button" aria-pressed={draft.days.includes(day)} onClick={() => toggleDay(day)} className={cn("min-w-11 rounded-full border px-2.5 py-1 text-xs", draft.days.includes(day) ? "border-foreground/40 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>{label}</button>)}
              </div>
              <p className="field-hint">{draft.days.length ? "Only on the days selected." : "None selected: every day."}</p>
            </div>
          </> : <Field label="Every" id="task-hours" error={errors.hours} hint="Counted from when the task is saved.">{(props) => <div className="flex items-center gap-2"><Input {...props} type="number" min={1} max={168} value={draft.hours} onChange={(event) => set({ hours: event.target.value })} className="w-24" /><span className="text-sm text-muted-foreground">hours</span></div>}</Field>}
        </div>
      </div>
      <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => void save()} disabled={busy}>{task ? "Save" : "Schedule"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function TaskRow({ server, task, onChanged }: { server: MinecraftServer; task: Task; onChanged: () => void }) {
  const { can, track } = usePanel();
  const now = useNow(30_000);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "run" | null>(null);
  const call = (key: string, work: () => Promise<void>) => track(`${server.id}:task:${task.id}:${key}`, async () => { await work(); onChanged(); });
  const toggle = (enabled: boolean) => call("toggle", async () => { await api(`/api/servers/${server.id}/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(payload(draftFrom(task), enabled)) }); });
  const runNow = () => call("run", async () => { const result = await api<{ ok: boolean; message: string }>(`/api/servers/${server.id}/tasks/${task.id}`, { method: "POST" }); (result.ok ? toast.success : toast.error)(result.message); });
  return <li className="flex items-start gap-3 px-4 py-3 sm:px-5">
    <div className="min-w-0 flex-1">
      <p className={cn("text-sm font-medium", !task.enabled && "text-muted-foreground")}>{what(task)}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {describeSchedule(task.schedule)}{task.schedule.type === "daily" && <> ({task.schedule.timeZone})</>}
        {task.enabled && task.nextRunAt ? <> · next <span title={formatDate(task.nextRunAt)}>{formatRelative(task.nextRunAt, now)}</span></> : !task.enabled ? " · paused" : null}
      </p>
      {task.lastResult && <p className={cn("mt-1 flex items-start gap-1 text-xs", task.lastResult.ok ? "text-muted-foreground" : "text-warning")}>
        {task.lastResult.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
        <span>Last run {formatRelative(task.lastResult.at, now)}: {task.lastResult.message}</span>
      </p>}
    </div>
    {can.manage && <>
      <Switch checked={task.enabled} onCheckedChange={(enabled) => void toggle(enabled)} aria-label={task.enabled ? "Pause task" : "Resume task"} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Task actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => task.kind === "restart" ? setConfirm("run") : void runNow()} disabled={server.status !== "running"}><Play />Run now</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil />Edit</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirm("delete")}><Trash2 />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>}
    {editing && <TaskDialog server={server} task={task} open={editing} onOpenChange={setEditing} onSaved={onChanged} />}
    <ConfirmDialog open={confirm === "run"} onOpenChange={(open) => !open && setConfirm(null)} title={`Restart ${server.name} now?`} confirmLabel="Restart now" onConfirm={() => void runNow()}>
      <p>Running it by hand restarts right away, without the chat warnings{server.playersOnline ? `; ${server.playersOnline} player${server.playersOnline === 1 ? "" : "s"} will be disconnected` : ""}. The schedule isn&apos;t affected.</p>
    </ConfirmDialog>
    <ConfirmDialog open={confirm === "delete"} onOpenChange={(open) => !open && setConfirm(null)} title="Delete this task?" confirmLabel="Delete task" destructive onConfirm={() => void call("delete", async () => { await api(`/api/servers/${server.id}/tasks/${task.id}`, { method: "DELETE" }); toast.success("Task deleted."); })}>
      <p>It stops running. You can schedule it again any time.</p>
    </ConfirmDialog>
  </li>;
}

export function ScheduleTab({ server }: { server: MinecraftServer }) {
  const { can } = usePanel();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try { setTasks((await api<{ tasks: Task[] }>(`/api/servers/${server.id}/tasks`)).tasks); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Couldn't load the schedule.")); }
  }, [server.id]);
  const finishedAt = server.lastOperation?.finishedAt;
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, finishedAt]);
  return <div className="space-y-5">
    <Section title="Scheduled tasks" description="Restarts, commands, and chat messages that run on their own. Backups have their own schedule, in Backups."
      actions={can.manage && <Button size="sm" onClick={() => setAdding(true)}><Plus />Add task</Button>}>
      {error ? <p className="text-sm text-destructive">{error}</p>
        : !tasks ? <Skeleton className="h-24" />
          : tasks.length ? <ul className="-mx-4 -my-4 divide-y divide-border sm:-mx-5 sm:-my-5">{tasks.map((task) => <TaskRow key={task.id} server={server} task={task} onChanged={() => void load()} />)}</ul>
            : <div className="grid place-items-center py-6 text-center text-sm text-muted-foreground"><CalendarClock className="mb-2 size-5" />{can.manage ? "Nothing scheduled yet. A daily restart in the early morning keeps most servers running smoothly." : "Nothing scheduled."}</div>}
    </Section>
    {adding && <TaskDialog server={server} open={adding} onOpenChange={setAdding} onSaved={() => void load()} />}
  </div>;
}
