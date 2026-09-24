"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, CalendarClock, CheckCircle2, CloudUpload, Download, MoreHorizontal, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field, Section } from "../common";
import { api, backupKind, backupKindLabels, type BackupKind, dayLabel, errorMessage, formatBytes, formatDate, formatRelative, safetyReason } from "../lib";
import { useNow, usePanel } from "../panel-context";
import type { Backup, BackupPolicy, BackupSchedule, MinecraftServer } from "../types";

type BackupData = { backups: Backup[]; policy: BackupPolicy; schedule: BackupSchedule };

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function ScheduleCard({ server, data, onSaved }: { server: MinecraftServer; data: BackupData; onSaved: () => void }) {
  const { track, isPending, can } = usePanel();
  const now = useNow(30_000);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.policy);
  const { policy, schedule } = data;
  // Fall back to the newest backup (e.g. legacy archives) when the scheduler has no record yet.
  const lastBackupAt = policy.lastRunAt || data.backups[0]?.createdAt;
  const failing = schedule.consecutiveFailures > 0;
  async function save() {
    await track(`${server.id}:policy`, async () => {
      await api(`/api/servers/${server.id}/backups/policy`, { method: "PUT", body: JSON.stringify({ enabled: draft.enabled, intervalHours: Number(draft.intervalHours), retention: Number(draft.retention) }) });
      toast.success("Backup schedule saved.");
      setEditing(false);
      onSaved();
    });
  }
  return <Section title="Automatic backups" description={server.offsite ? "Stored on this host and copied offsite." : "Stored on this host."}
    actions={!editing && can.restore && <Button size="sm" variant="outline" onClick={() => { setDraft(policy); setEditing(true); }}><Pencil />Edit</Button>}>
    {editing ? <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
        <Label htmlFor="backup-enabled" className="flex-col items-start gap-0.5 font-normal"><span className="block font-medium">Back up automatically</span><span className="block text-xs text-muted-foreground">Runs without stopping the server.</span></Label>
        <Switch id="backup-enabled" checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Every" id="backup-hours" hint="Hours between backups (1–168).">{(props) => <div className="flex items-center gap-2"><Input {...props} type="number" min={1} max={168} value={draft.intervalHours} onChange={(event) => setDraft({ ...draft, intervalHours: Number(event.target.value) })} disabled={!draft.enabled} /><span className="text-sm text-muted-foreground">hours</span></div>}</Field>
        <Field label="Keep" id="backup-retention" hint="Newest scheduled and manual backups kept, each. The last 5 safety backups are always kept.">{(props) => <div className="flex items-center gap-2"><Input {...props} type="number" min={1} max={100} value={draft.retention} onChange={(event) => setDraft({ ...draft, retention: Number(event.target.value) })} /><span className="text-sm text-muted-foreground">backups</span></div>}</Field>
      </div>
      <div className="flex gap-2"><Button size="sm" onClick={() => void save()} disabled={isPending(`${server.id}:policy`)}>Save schedule</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
    </div> : <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {policy.enabled ? <><CalendarClock className="size-4 text-muted-foreground" /><span className="font-medium">Every {policy.intervalHours} hour{policy.intervalHours === 1 ? "" : "s"}</span><span className="text-muted-foreground">· keeps {policy.retention} · next {schedule.nextRunAt ? formatRelative(schedule.nextRunAt, now) : "soon"}</span></>
          : <span className="text-muted-foreground">Off. Only manual and safety backups are made.</span>}
      </p>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        {failing ? <AlertTriangle className="size-4 text-destructive" /> : lastBackupAt ? <CheckCircle2 className="size-4 text-success" /> : null}
        Last backup {lastBackupAt ? <span title={formatDate(lastBackupAt)}>{formatRelative(lastBackupAt, now)}</span> : "never"}
      </p>
      {failing && <p className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">{schedule.lastFailure || `The last ${schedule.consecutiveFailures} scheduled backups failed.`} Retrying automatically with a growing delay.</p>}
      <OffsiteLine server={server} now={now} />
    </div>}
  </Section>;
}

function OffsiteLine({ server, now }: { server: MinecraftServer; now: number }) {
  const { can } = usePanel();
  if (!server.offsite) return can.offsite ? <p className="text-xs text-muted-foreground"><Link href="/backups" className="underline underline-offset-2 hover:text-foreground">Set up offsite backups</Link> to keep copies off this machine.</p> : null;
  const { lastCopyAt, lastError } = server.offsite;
  return <p className={cn("flex items-center gap-1.5", lastError ? "text-destructive" : "text-muted-foreground")}>
    <CloudUpload className="size-4" />{lastError ? "Last offsite copy failed" : lastCopyAt ? <>Offsite: copied <span title={formatDate(lastCopyAt)}>{formatRelative(lastCopyAt, now)}</span></> : "Offsite: waiting for the first copy"}
  </p>;
}

type OffsiteSnapshot = { id: string; time: string; path: string; size: number; kind: string };

/** Offsite copies of this server, loaded on request (listing them reaches the destination). */
function OffsiteSnapshots({ server }: { server: MinecraftServer }) {
  const { track } = usePanel();
  const [snapshots, setSnapshots] = useState<OffsiteSnapshot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<OffsiteSnapshot | null>(null);
  async function load() {
    setLoading(true); setError("");
    try { setSnapshots((await api<{ snapshots: OffsiteSnapshot[] }>(`/api/servers/${server.id}/offsite`)).snapshots); }
    catch (reason) { setError(errorMessage(reason, "Couldn't reach the offsite destination.")); }
    finally { setLoading(false); }
  }
  async function restore(snapshot: OffsiteSnapshot) {
    await track(`${server.id}:restore`, async () => {
      const result = await api<{ message: string }>(`/api/servers/${server.id}/offsite`, { method: "POST", body: JSON.stringify({ snapshot: snapshot.id }) });
      toast.success(result.message);
    });
  }
  return <Section title="Offsite copies" description="Restore from here if the backups on this machine are damaged or gone."
    actions={<Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>{snapshots ? "Refresh" : "Show"}</Button>}>
    {error ? <p className="text-xs text-destructive">{error}</p>
      : loading ? <Skeleton className="h-16" />
        : !snapshots ? <p className="text-xs text-muted-foreground">Listed from the destination when you ask.</p>
          : !snapshots.length ? <p className="text-xs text-muted-foreground">Nothing copied yet.</p>
            : <ul className="-mx-4 max-h-80 divide-y divide-border overflow-y-auto sm:-mx-5">{snapshots.map((snapshot) => <li key={snapshot.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
              <div className="min-w-0 flex-1"><p className="text-sm">{formatDate(snapshot.time)}</p><p className="text-xs text-muted-foreground">{backupKindLabels[backupKind(snapshot)]}{snapshot.size ? ` · ${formatBytes(snapshot.size)}` : ""}</p></div>
              <Button size="sm" variant="ghost" disabled={Boolean(server.operation)} onClick={() => setConfirm(snapshot)}><Undo2 />Restore</Button>
            </li>)}</ul>}
    <ConfirmDialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)} title={confirm ? `Roll ${server.name} back to ${formatDate(confirm.time)}?` : ""} confirmLabel="Restore this copy" onConfirm={() => { if (confirm) void restore(confirm); }}>
      <p><span className="font-medium text-foreground">Everything built or changed after that time will be lost.</span> The world is downloaded from the offsite destination, which can take a while.</p>
      <p>A safety backup of the current world is taken first, so you can undo this.</p>
    </ConfirmDialog>
  </Section>;
}

function BackupRow({ server, backup, onChanged }: { server: MinecraftServer; backup: Backup; onChanged: () => void }) {
  const { track, can } = usePanel();
  const now = useNow(60_000);
  const [confirm, setConfirm] = useState<"restore" | "delete" | null>(null);
  const kind = backupKind(backup);
  const size = backup.logicalSize ? `${formatBytes(backup.logicalSize)} world · ${formatBytes(backup.size)} new data stored` : "Complete backup";
  const busy = Boolean(server.operation);
  const download = `/api/servers/${server.id}/backups/${encodeURIComponent(backup.name)}`;
  async function restore() {
    await track(`${server.id}:restore`, async () => {
      const result = await api<{ message: string }>(`/api/servers/${server.id}/backups`, { method: "POST", body: JSON.stringify({ name: backup.name }) });
      toast.success(result.message);
    });
  }
  async function remove() {
    await track(`${server.id}:delete-backup`, async () => { await api(download, { method: "DELETE" }); toast.success("Backup deleted."); onChanged(); });
  }
  return <li className="flex items-center gap-3 px-4 py-3">
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{timeLabel(backup.createdAt)}</span>
        {now - new Date(backup.createdAt).getTime() < 86_400_000 && <span className="text-muted-foreground">{formatRelative(backup.createdAt, now)}</span>}
        <Badge variant="outline" className={cn("font-normal", kind === "safety" && "border-warning/40 text-warning", kind === "manual" && "border-foreground/30")}>{backupKindLabels[kind]}</Badge>
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{kind === "safety" ? `Taken automatically ${safetyReason(backup.kind)} · ` : ""}{size}</p>
    </div>
    {can.restore && <><Button size="sm" variant="outline" className="hidden sm:inline-flex" onClick={() => setConfirm("restore")} disabled={busy}><Undo2 />Restore</Button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`More actions for the backup from ${formatDate(backup.createdAt)}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem className="sm:hidden" disabled={busy} onSelect={() => setConfirm("restore")}><Undo2 />Restore</DropdownMenuItem>
        <DropdownMenuItem asChild><a href={download}><Download />Download as .tar</a></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={busy} onSelect={() => setConfirm("delete")}><Trash2 />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu></>}
    <ConfirmDialog open={confirm === "restore"} onOpenChange={(open) => !open && setConfirm(null)} title={`Roll ${server.name} back to ${formatDate(backup.createdAt)}?`} confirmLabel="Restore this backup" onConfirm={() => void restore()}>
      <p><span className="font-medium text-foreground">Everything built or changed after that time will be lost.</span></p>
      <p>A safety backup of the current world is taken first, so you can undo this by restoring it.</p>
      <p>The server goes offline for about 2 minutes{server.playersOnline ? `; ${server.playersOnline} player${server.playersOnline === 1 ? "" : "s"} online will be disconnected` : ""}.</p>
    </ConfirmDialog>
    <ConfirmDialog open={confirm === "delete"} onOpenChange={(open) => !open && setConfirm(null)} title="Delete this backup?" confirmLabel="Delete backup" destructive onConfirm={() => void remove()}>
      <p>The {backupKindLabels[kind].toLowerCase()} backup from {formatDate(backup.createdAt)} will be removed permanently. Other backups aren&apos;t affected.</p>
    </ConfirmDialog>
  </li>;
}

export function BackupsTab({ server }: { server: MinecraftServer }) {
  const { runAction, isPending, can } = usePanel();
  const [data, setData] = useState<BackupData | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<BackupKind | "all">("all");
  const load = useCallback(async () => {
    try { setData(await api<BackupData>(`/api/servers/${server.id}/backups`)); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Backups are unavailable.")); }
  }, [server.id]);
  const finishedAt = server.lastOperation?.finishedAt;
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, finishedAt]);

  const groups = useMemo(() => {
    const list = (data?.backups || []).filter((backup) => filter === "all" || backupKind(backup) === filter);
    const byDay = new Map<string, Backup[]>();
    for (const backup of list) { const day = dayLabel(backup.createdAt); byDay.set(day, [...(byDay.get(day) || []), backup]); }
    return [...byDay];
  }, [data, filter]);
  const counts = useMemo(() => { const result = { all: 0, scheduled: 0, manual: 0, safety: 0 }; for (const backup of data?.backups || []) { result.all += 1; result[backupKind(backup)] += 1; } return result; }, [data]);

  return <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
    <div className="order-2 space-y-3 lg:order-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-sm font-semibold">Backups</h2><p className="mt-0.5 text-xs text-muted-foreground">Each backup is a complete copy. Deleting one never affects the others.</p></div>
        {can.control && <Button size="sm" onClick={() => void runAction(server, "backup")} disabled={Boolean(server.operation) || isPending(`${server.id}:backup`)}><Plus />Back up now</Button>}
      </div>
      {counts.all > 10 && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter backups">
        {(["all", "scheduled", "manual", "safety"] as const).map((item) => <button key={item} type="button" aria-pressed={filter === item} onClick={() => setFilter(item)} className={cn("rounded-full border px-3 py-1 text-xs", filter === item ? "border-foreground/40 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>{item === "all" ? "All" : backupKindLabels[item]} ({counts[item]})</button>)}
      </div>}
      {error ? <p className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>
        : !data ? <Skeleton className="h-48" />
          : groups.length ? groups.map(([day, backups]) => <section key={day} aria-label={day} className="overflow-hidden rounded-xl border border-border bg-card">
            <h3 className="border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">{day}</h3>
            <ul className="divide-y divide-border">{backups.map((backup) => <BackupRow key={backup.name} server={server} backup={backup} onChanged={() => void load()} />)}</ul>
          </section>)
            : <div className="grid place-items-center rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground"><Archive className="mb-2 size-5" />{filter === "all" ? "No backups yet. The first one runs automatically, or back up now." : "No backups of this kind."}</div>}
    </div>
    <div className="order-1 space-y-5 lg:order-2">
      {data ? <ScheduleCard key={JSON.stringify(data.policy)} server={server} data={data} onSaved={() => void load()} /> : <Skeleton className="h-36" />}
      {server.offsite && can.offsite && <OffsiteSnapshots server={server} />}
    </div>
  </div>;
}
