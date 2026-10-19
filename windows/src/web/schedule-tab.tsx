import { useCallback, useEffect, useState } from "react";
import { Clock, LoaderCircle, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { describeSchedule, WEEKDAYS, type ScheduledTask, type TaskKind } from "../../../lib/tasks";
import type { Activity, BackupPolicy } from "../server/control";
import { api, formatRelative, type Server } from "./api";
import { Dialog, Field, run, Section } from "./ui";

type Task = ScheduledTask & { nextRunAt?: string };
const label = (kind: TaskKind) => kind === "restart" ? "Restart server" : kind === "broadcast" ? "Chat message" : "Console command";

export function ScheduleTab({ server }: { server: Server }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const prefix = `/api/servers/${server.id}/tasks`;
  const load = useCallback(async () => {
    try { const data = await api<{ tasks: Task[] }>(`/api/servers/${server.id}/tasks`); setTasks(data.tasks); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load tasks."); }
  }, [server.id]);
  useEffect(() => { void load(); const timer = setInterval(load, 10000); return () => clearInterval(timer); }, [load]);
  return <>
    <Section title="Scheduled tasks" description="Restart the server, run a command, or send a chat message. The panel must stay open; tasks skip stopped servers."
      actions={<button className="btn btn-primary btn-sm" onClick={() => setEditing("new")} disabled={(tasks?.length ?? 0) >= 20}><Plus />Add task</button>}>
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      {tasks === null ? <p className="text-sm text-muted-foreground">Loading…</p> : !tasks.length ? <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet. Add a restart, command, or chat message.</p>
        : <ul className="divide-y divide-border">{tasks.map((task) => <li key={task.id} className="flex flex-wrap items-start gap-3 py-4 text-sm">
          <Clock className="mt-0.5 size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1"><p className="font-semibold">{label(task.kind)} {!task.enabled && <span className="ml-2 text-xs font-normal text-muted-foreground">Paused</span>}</p>
            <p className="mt-1 text-xs text-muted-foreground">{describeSchedule(task.schedule)}{task.schedule.type === "daily" ? ` · ${task.schedule.timeZone}` : ""}</p>
            {task.kind !== "restart" && <p className="mt-1 break-all font-mono text-xs">{task.kind === "command" ? task.command : task.message}</p>}
            {task.nextRunAt && <p className="mt-1 text-xs text-muted-foreground">Next: {new Date(task.nextRunAt).toLocaleString()}</p>}
            {task.lastResult && <p className={`mt-1 text-xs ${task.lastResult.ok ? "text-muted-foreground" : "text-destructive"}`}>{task.lastResult.message} · {formatRelative(task.lastResult.at)}</p>}
          </div>
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => { setBusy(true); void run(async () => { await api(`${prefix}/${task.id}`, { method: "PUT", body: { ...task, enabled: !task.enabled } }); await load(); }).finally(() => setBusy(false)); }}>{task.enabled ? "Pause" : "Enable"}</button>
          <button className="btn btn-ghost btn-sm" aria-label="Edit task" onClick={() => setEditing(task)}><Pencil /></button>
          <button className="btn btn-ghost btn-sm" aria-label="Delete task" onClick={() => setDeleting(task)}><Trash2 /></button>
        </li>)}</ul>}
    </Section>
    {editing && <TaskEditor key={typeof editing === "string" ? "new" : editing.id} task={editing === "new" ? undefined : editing} serverId={server.id} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    {deleting && <Dialog title="Delete scheduled task?" onClose={() => setDeleting(null)} footer={<><button className="btn btn-outline" onClick={() => setDeleting(null)}>Cancel</button><button className="btn btn-danger" disabled={busy} onClick={() => { setBusy(true); void run(async () => { await api(`${prefix}/${deleting.id}`, { method: "DELETE" }); setDeleting(null); await load(); }, "Task deleted.").finally(() => setBusy(false)); }}>Delete</button></>}>
      <p className="text-sm text-muted-foreground">This removes the schedule. You can create another task at any time.</p>
    </Dialog>}
  </>;
}

function TaskEditor({ task, serverId, onClose, onSaved }: { task?: Task; serverId: string; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<TaskKind>(task?.kind ?? "restart");
  const [type, setType] = useState<"daily" | "interval">(task?.schedule.type ?? "daily");
  const [time, setTime] = useState(task?.schedule.type === "daily" ? task.schedule.time : "04:00");
  const [days, setDays] = useState<number[]>(task?.schedule.type === "daily" ? task.schedule.days : []);
  const [timeZone, setTimeZone] = useState(task?.schedule.type === "daily" ? task.schedule.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [hours, setHours] = useState(task?.schedule.type === "interval" ? task.schedule.hours : 6);
  const [text, setText] = useState(task?.command ?? task?.message ?? "");
  const [warnMinutes, setWarnMinutes] = useState(task?.warnMinutes ?? 5);
  const [busy, setBusy] = useState(false);
  const save = () => {
    const schedule = type === "daily" ? { type, time, days, timeZone } : { type, hours };
    setBusy(true);
    void run(async () => {
      await api(`/api/servers/${serverId}/tasks${task ? `/${task.id}` : ""}`, { method: task ? "PUT" : "POST", body: { kind, schedule, warnMinutes, enabled: task?.enabled ?? true, ...(kind === "command" ? { command: text } : kind === "broadcast" ? { message: text } : {}) } });
      onSaved();
    }, "Task saved.").finally(() => setBusy(false));
  };
  return <Dialog title={task ? "Edit task" : "Add scheduled task"} onClose={() => { if (!busy) onClose(); }} footer={<><button className="btn btn-outline" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || (kind !== "restart" && !text.trim())} onClick={save}>{busy ? <LoaderCircle className="animate-spin" /> : <Save />}Save task</button></>}>
    <div className="grid gap-4">
      <Field label="Action"><select className="input" value={kind} onChange={(event) => setKind(event.target.value as TaskKind)}>{(["restart", "command", "broadcast"] as const).map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></Field>
      {kind !== "restart" && <Field label={kind === "command" ? "Command" : "Chat message"}><input className="input" value={text} maxLength={kind === "command" ? 512 : 200} onChange={(event) => setText(event.target.value)} /></Field>}
      {kind === "restart" && <Field label="Warn players before restarting" hint="Warnings are sent in chat when players are online."><select className="input" value={warnMinutes} onChange={(event) => setWarnMinutes(Number(event.target.value))}>{[0, 1, 3, 5, 10, 15, 30].map((value) => <option key={value} value={value}>{value ? `${value} minutes` : "No warning"}</option>)}</select></Field>}
      <Field label="Repeat"><select className="input" value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="daily">At a daily time</option><option value="interval">Every few hours</option></select></Field>
      {type === "interval" ? <Field label="Interval in hours"><input className="input" type="number" min={1} max={168} value={hours} onChange={(event) => setHours(Number(event.target.value))} /></Field> : <>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Time"><input className="input" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></Field><Field label="Time zone"><input className="input" value={timeZone} maxLength={64} onChange={(event) => setTimeZone(event.target.value)} /></Field></div>
        <fieldset><legend className="mb-2 text-sm font-medium">Days <span className="font-normal text-muted-foreground">(none selected means every day)</span></legend><div className="flex flex-wrap gap-2">{WEEKDAYS.map((day, index) => <label key={day} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={days.includes(index)} onChange={(event) => setDays(event.target.checked ? [...days, index] : days.filter((d) => d !== index))} />{day}</label>)}</div></fieldset>
      </>}
    </div>
  </Dialog>;
}

export function BackupPolicyForm({ server }: { server: Server }) {
  const [policy, setPolicy] = useState<BackupPolicy | null>(null);
  const [lastError, setLastError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let canceled = false;
    void api<{ policy: BackupPolicy; schedule?: { lastError?: string } }>(`/api/servers/${server.id}/backup-policy`).then((data) => { if (!canceled) { setPolicy(data.policy); setLastError(data.schedule?.lastError || ""); } }).catch((error) => { if (!canceled) setLastError(error.message); });
    return () => { canceled = true; };
  }, [server.id]);
  return <Section title="Backup settings" description="Keep the panel open for scheduled backups. Retention removes only old scheduled copies; manual and safety copies are kept."
    actions={<button className="btn btn-primary btn-sm" disabled={!policy || busy} onClick={() => { setBusy(true); void run(async () => { await api(`/api/servers/${server.id}/backup-policy`, { method: "PUT", body: policy }); setLastError(""); }, "Backup schedule saved.").finally(() => setBusy(false)); }}><Save />Save schedule</button>}>
    {policy ? <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Storage"><select className="input" value={policy.mode ?? "copy"} onChange={(event) => setPolicy({ ...policy, mode: event.target.value as BackupPolicy["mode"] })}><option value="copy">Full folder copies</option><option value="incremental">Encrypted incremental</option></select></Field>
      <label className="flex h-9 items-center gap-2 text-sm font-medium"><input type="checkbox" checked={policy.enabled} onChange={(event) => setPolicy({ ...policy, enabled: event.target.checked })} />Enable automatic backups</label>
      <Field label="Every (hours)"><input className="input" type="number" min={1} max={168} value={policy.intervalHours} onChange={(event) => setPolicy({ ...policy, intervalHours: Number(event.target.value) })} /></Field>
      <Field label="Scheduled copies to keep"><input className="input" type="number" min={1} max={500} value={policy.retention} onChange={(event) => setPolicy({ ...policy, retention: Number(event.target.value) })} /></Field>
    </div> : <p className="text-sm text-muted-foreground">Loading schedule…</p>}
    {lastError && <p role="alert" className="mt-3 text-sm text-destructive">{lastError}</p>}
    {policy?.lastRunAt && <p className="mt-3 text-xs text-muted-foreground">Last scheduled backup: {new Date(policy.lastRunAt).toLocaleString()}</p>}
    {policy?.mode === "incremental" && <div className="mt-4 border-t border-border pt-4">
      <p className="text-xs leading-5 text-muted-foreground">Incremental backups store only changed data and encrypt it with restic. First use downloads the backup tool. Keep your complete Blocky data folder, including its backup key, so you can restore these snapshots later. Existing full copies remain usable.</p>
      <div className="mt-3 flex flex-wrap gap-2">{([false, true] as const).map((prune) => <button key={String(prune)} className="btn btn-outline btn-sm" disabled={busy || !!server.operation} onClick={() => { setBusy(true); void run(() => api(`/api/servers/${server.id}/backup-maintenance`, { method: "POST", body: { prune } }), prune ? "Unused backup data reclaimed." : "Repository integrity check completed.").finally(() => setBusy(false)); }}>{prune ? "Reclaim unused space" : "Check repository"}</button>)}</div>
    </div>}
  </Section>;
}

export function ActivityTab({ server }: { server: Server }) {
  const [events, setEvents] = useState<Activity[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    const load = () => api<{ events: Activity[] }>(`/api/servers/${server.id}/events`).then((data) => { if (!canceled) { setEvents(data.events); setError(""); } }).catch((error) => { if (!canceled) setError(error.message); });
    void load(); const timer = setInterval(load, 5000);
    return () => { canceled = true; clearInterval(timer); };
  }, [server.id]);
  return <Section title="Activity" description="The latest 200 server actions, backup results, and scheduled tasks. Command text is kept out of this log.">
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {events === null ? <p className="text-sm text-muted-foreground">Loading…</p> : !events.length ? <p className="text-sm text-muted-foreground">No activity yet.</p> : <ul className="divide-y divide-border">{events.map((event) => <li key={event.id} className="flex gap-3 py-3 text-sm"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${event.level === "error" ? "bg-destructive" : event.level === "success" ? "bg-success" : "bg-muted-foreground"}`} /><div><p>{event.message}</p><time dateTime={event.at} className="mt-1 block text-xs text-muted-foreground">{new Date(event.at).toLocaleString()}</time></div></li>)}</ul>}
  </Section>;
}
