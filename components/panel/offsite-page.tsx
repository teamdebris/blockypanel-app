"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudUpload, History, KeyRound, LoaderCircle, MoveRight, Power, RefreshCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PASSPHRASE_MIN_LENGTH, PASSPHRASE_MIN_WORDS, passphraseProblem } from "@/lib/offsite-core";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field, PageHeading, Section } from "./common";
import { DestinationFields, type DestinationDraft, destinationPayload, draftFrom, emptyDraft, type PublicDestination, TestConnection } from "./offsite-destination";
import { api, ApiError, errorMessage, formatDate, formatRelative } from "./lib";
import { useNow, usePanel } from "./panel-context";

type Schedule = "after-backup" | "daily";
type RestoreJob = { startedAt: string; finishedAt?: string; message?: string; servers: { id: string; name: string; state: "waiting" | "restoring" | "done" | "failed"; message?: string }[] };
type Overview = {
  configured: boolean;
  destination?: PublicDestination;
  label?: string;
  schedule?: Schedule;
  keep?: number;
  configuredAt?: string;
  status: { lastRunAt?: string; lastSuccessAt?: string; lastError?: string; copying: boolean; servers: Record<string, { lastCopyAt?: string; lastError?: string }> };
  restore?: RestoreJob;
  sshPublicKey?: string;
};
type FoundServer = { id: string; name: string; type: string; version: string; lastCopyAt: string; removed: boolean; here: boolean };

const scheduleLabels: Record<Schedule, string> = { "after-backup": "After each backup", daily: "Once a day" };

function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError && error.field ? { [error.field.replace(/^destination\./, "")]: error.message } : {};
}

function PassphraseFields({ value, confirm, onValue, onConfirm, error, confirmNeeded }: { value: string; confirm: string; onValue: (value: string) => void; onConfirm: (value: string) => void; error?: string; confirmNeeded: boolean }) {
  const problem = value ? passphraseProblem(value) : null;
  const mismatch = confirmNeeded && confirm && confirm !== value ? "The passphrases don't match." : undefined;
  return <div className="grid gap-4 sm:grid-cols-2">
    <Field label="Backup passphrase" id="offsite-passphrase" error={error || problem || undefined} hint={confirmNeeded ? `At least ${PASSPHRASE_MIN_WORDS} words or ${PASSPHRASE_MIN_LENGTH} characters, like "maple otter lantern river quilt".` : "The passphrase chosen when offsite backups were set up."}>
      {(props) => <Input {...props} type="password" value={value} onChange={(event) => onValue(event.target.value)} autoComplete="new-password" />}
    </Field>
    {confirmNeeded && <Field label="Type it again" id="offsite-passphrase-confirm" error={mismatch}>{(props) => <Input {...props} type="password" value={confirm} onChange={(event) => onConfirm(event.target.value)} autoComplete="new-password" />}</Field>}
  </div>;
}

/** Setting up, or moving to another destination. */
function SetupForm({ overview, onDone, onCancel }: { overview: Overview; onDone: () => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState<DestinationDraft>(() => draftFrom(overview.destination));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [schedule, setSchedule] = useState<Schedule>(overview.schedule || "after-backup");
  const [keep, setKeep] = useState(String(overview.keep || 30));
  const [sshKey, setSshKey] = useState(overview.sshPublicKey);
  const [busy, setBusy] = useState(false);
  const ready = !passphraseProblem(passphrase) && passphrase === confirm;
  async function save() {
    setBusy(true); setErrors({});
    try {
      await api("/api/offsite", { method: "PUT", body: JSON.stringify({ destination: destinationPayload(draft), passphrase, schedule, keep: Number(keep) }) });
      toast.success("Offsite backups are on. The first copy is running.");
      onDone();
    } catch (error) { setErrors(fieldErrors(error)); toast.error(errorMessage(error, "Couldn't set up offsite backups.")); }
    finally { setBusy(false); }
  }
  return <Section title={overview.configured ? "Move offsite backups" : "Set up offsite backups"} description="Copies of every server's backups, somewhere other than this machine. Only what changed is sent each time.">
    <div className="space-y-6">
      <DestinationFields draft={draft} onChange={setDraft} errors={errors} sshPublicKey={sshKey} onSshKey={setSshKey} />
      <TestConnection draft={draft} onChange={setDraft} onErrors={setErrors} />
      <div className="space-y-3 border-t border-border pt-5">
        <h3 className="text-sm font-semibold">Backup passphrase</h3>
        <p className="text-xs leading-5 text-muted-foreground">Everything is encrypted before it leaves this machine. To restore on a new machine you need the destination details above and this passphrase. <span className="font-medium text-foreground">Keep it in a password manager: it can&apos;t be recovered.</span></p>
        <PassphraseFields value={passphrase} confirm={confirm} onValue={setPassphrase} onConfirm={setConfirm} error={errors.passphrase} confirmNeeded />
      </div>
      <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <Field label="Copy" id="offsite-schedule">{(props) => <Select value={schedule} onValueChange={(value) => setSchedule(value as Schedule)}>
          <SelectTrigger {...props} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(scheduleLabels) as Schedule[]).map((value) => <SelectItem key={value} value={value}>{scheduleLabels[value]}</SelectItem>)}</SelectContent>
        </Select>}</Field>
        <Field label="Keep" id="offsite-keep" hint="Offsite backups kept of each kind, per server. Never fewer than the server keeps locally.">{(props) => <div className="flex items-center gap-2"><Input {...props} type="number" min={1} max={500} value={keep} onChange={(event) => setKeep(event.target.value)} /><span className="text-sm text-muted-foreground">backups</span></div>}</Field>
      </div>
      {draft.kind === "s3" && <p className="text-xs leading-5 text-muted-foreground">Tip: turn on object versioning or object lock for the bucket at your provider. Then even someone who takes over this panel can&apos;t erase your older copies.</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy || !ready}>{busy ? <LoaderCircle className="animate-spin" /> : <CloudUpload />}{overview.configured ? "Move and copy" : "Turn on and copy now"}</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  </Section>;
}

/** Disaster recovery: open a destination with the passphrase, pick servers, bring them back. */
function RestoreForm({ overview, onStarted, onCancel }: { overview: Overview; onStarted: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<DestinationDraft>(() => overview.destination ? draftFrom(overview.destination) : emptyDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [passphrase, setPassphrase] = useState("");
  const [sshKey, setSshKey] = useState(overview.sshPublicKey);
  const [found, setFound] = useState<FoundServer[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const now = useNow(60_000);
  const body = () => ({ destination: destinationPayload(draft), passphrase });
  async function discover() {
    setBusy(true); setErrors({}); setFound(null);
    try {
      const { servers } = await api<{ servers: FoundServer[] }>("/api/offsite/discover", { method: "POST", body: JSON.stringify(body()) });
      setFound(servers);
      setChosen(new Set(servers.filter((server) => !server.here && !server.removed).map((server) => server.id)));
    } catch (error) { setErrors(fieldErrors(error)); toast.error(errorMessage(error, "Couldn't open the backups.")); }
    finally { setBusy(false); }
  }
  async function restore() {
    setBusy(true);
    try {
      const result = await api<{ message: string }>("/api/offsite/restore", { method: "POST", body: JSON.stringify({ ...body(), servers: [...chosen] }) });
      toast.success(result.message);
      onStarted();
    } catch (error) { toast.error(errorMessage(error, "Couldn't start the restore.")); }
    finally { setBusy(false); }
  }
  return <Section title="Restore from an offsite backup" description="Brings servers back with their settings and newest world, for example on a new machine. Each one keeps its address and port.">
    <div className="space-y-6">
      <DestinationFields draft={draft} onChange={(next) => { setDraft(next); setFound(null); }} errors={errors} sshPublicKey={sshKey} onSshKey={setSshKey} />
      <TestConnection draft={draft} onChange={setDraft} onErrors={setErrors} />
      <div className="border-t border-border pt-5"><PassphraseFields value={passphrase} confirm="" onValue={(value) => { setPassphrase(value); setFound(null); }} onConfirm={() => undefined} error={errors.passphrase} confirmNeeded={false} /></div>
      {!found && <div className="flex flex-wrap gap-2"><Button onClick={() => void discover()} disabled={busy || !passphrase}>{busy ? <LoaderCircle className="animate-spin" /> : <History />}Find my servers</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>}
      {found && <div className="space-y-3">
        {found.length ? <ul className="divide-y divide-border rounded-xl border border-border">
          {found.map((server) => <li key={server.id} className="flex items-center gap-3 px-4 py-3">
            <Checkbox id={`restore-${server.id}`} checked={chosen.has(server.id)} disabled={server.here} onCheckedChange={(checked) => setChosen((current) => { const next = new Set(current); if (checked) next.add(server.id); else next.delete(server.id); return next; })} />
            <label htmlFor={`restore-${server.id}`} className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{server.name}</span>
              <span className="block text-xs text-muted-foreground">{server.type} {server.version} · copied {server.lastCopyAt ? formatRelative(server.lastCopyAt, now) : "never"}{server.here ? " · already on this panel" : server.removed ? " · removed from its panel" : ""}</span>
            </label>
          </li>)}
        </ul> : <p className="text-sm text-muted-foreground">No servers are stored at this destination yet.</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void restore()} disabled={busy || !chosen.size}>{busy ? <LoaderCircle className="animate-spin" /> : <History />}Restore {chosen.size || ""} server{chosen.size === 1 ? "" : "s"}</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>}
    </div>
  </Section>;
}

function RestoreProgress({ job }: { job: RestoreJob }) {
  const icon = (state: RestoreJob["servers"][number]["state"]) => state === "done" ? <CheckCircle2 className="size-4 text-success" /> : state === "failed" ? <XCircle className="size-4 text-destructive" /> : state === "restoring" ? <LoaderCircle className="size-4 animate-spin text-warning" /> : <span className="size-4 rounded-full border border-border" />;
  return <Section title={job.finishedAt ? "Restore finished" : "Restoring servers"} description={job.finishedAt ? `Finished ${formatDate(job.finishedAt)}.` : "Downloading worlds and recreating servers, one at a time. You can leave this page."}>
    <ul className="space-y-2">{job.servers.map((server) => <li key={server.id} className="flex items-start gap-2 text-sm">{icon(server.state)}<span><span className="font-medium">{server.name}</span>{server.message && <span className="block text-xs text-destructive">{server.message}</span>}</span></li>)}</ul>
    {job.message && <p className="mt-3 text-xs text-muted-foreground">{job.message}</p>}
  </Section>;
}

function PassphraseDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError("");
    try { await api("/api/offsite", { method: "PATCH", body: JSON.stringify({ passphrase }) }); toast.success("Passphrase changed. The old one no longer works."); onOpenChange(false); onDone(); }
    catch (reason) { setError(errorMessage(reason, "Couldn't change the passphrase.")); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!next) { setPassphrase(""); setConfirm(""); setError(""); } onOpenChange(next); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Change the backup passphrase</DialogTitle><DialogDescription>The new passphrase opens every copy already at the destination. The old one stops working right away.</DialogDescription></DialogHeader>
      <PassphraseFields value={passphrase} confirm={confirm} onValue={setPassphrase} onConfirm={setConfirm} error={error} confirmNeeded />
      <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={() => void save()} disabled={busy || Boolean(passphraseProblem(passphrase)) || passphrase !== confirm}>Change passphrase</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function StatusCard({ overview, onChanged, onMove, onRestore }: { overview: Overview; onChanged: () => void; onMove: () => void; onRestore: () => void }) {
  const { servers, track, isPending } = usePanel();
  const now = useNow(30_000);
  const [confirmOff, setConfirmOff] = useState(false);
  const [changingPassphrase, setChangingPassphrase] = useState(false);
  const [schedule, setSchedule] = useState<Schedule>(overview.schedule || "after-backup");
  const [keep, setKeep] = useState(String(overview.keep || 30));
  const { status } = overview;
  const dirty = schedule !== overview.schedule || Number(keep) !== overview.keep;
  return <>
    <Section title="Offsite backups" description={overview.label}
      actions={<Button size="sm" variant="outline" disabled={status.copying || isPending("offsite:copy")} onClick={() => void track("offsite:copy", async () => { await api("/api/offsite/copy", { method: "POST" }); toast.success("Copying now."); onChanged(); })}>
        {status.copying ? <LoaderCircle className="animate-spin" /> : <RefreshCcw />}{status.copying ? "Copying…" : "Copy now"}
      </Button>}>
      <div className="space-y-4 text-sm">
        <p className="flex items-center gap-1.5 text-muted-foreground">
          {status.lastError ? <AlertTriangle className="size-4 text-destructive" /> : status.lastSuccessAt ? <CheckCircle2 className="size-4 text-success" /> : <LoaderCircle className="size-4 animate-spin" />}
          {status.lastSuccessAt ? <>Last complete copy {formatRelative(status.lastSuccessAt, now)}</> : status.copying ? "The first copy is running. A large world can take a while." : "No complete copy yet."}
        </p>
        {status.lastError && <p className="rounded-lg border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive">{status.lastError} Retrying automatically. Local backups aren&apos;t affected.</p>}
        {servers.length > 0 && <ul className="divide-y divide-border rounded-xl border border-border">
          {servers.map((server) => { const item = status.servers[server.id]; return <li key={server.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span className="font-medium">{server.name}</span>
            <span className={cn("text-xs", item?.lastError ? "text-destructive" : "text-muted-foreground")}>{item?.lastError ? "Last copy failed" : item?.lastCopyAt ? `Copied ${formatRelative(item.lastCopyAt, now)}` : server.backupCount ? "Waiting for the next copy" : "No backups yet"}</span>
          </li>; })}
        </ul>}
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Copy" id="offsite-schedule-edit">{(props) => <Select value={schedule} onValueChange={(value) => setSchedule(value as Schedule)}>
            <SelectTrigger {...props} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(scheduleLabels) as Schedule[]).map((value) => <SelectItem key={value} value={value}>{scheduleLabels[value]}</SelectItem>)}</SelectContent>
          </Select>}</Field>
          <Field label="Keep" id="offsite-keep-edit">{(props) => <div className="flex items-center gap-2"><Input {...props} type="number" min={1} max={500} value={keep} onChange={(event) => setKeep(event.target.value)} /><span className="text-sm text-muted-foreground">backups</span></div>}</Field>
          <Button variant="outline" disabled={!dirty || isPending("offsite:settings")} onClick={() => void track("offsite:settings", async () => { await api("/api/offsite", { method: "PATCH", body: JSON.stringify({ schedule, keep: Number(keep) }) }); toast.success("Saved."); onChanged(); })}>Save</Button>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button size="sm" variant="outline" onClick={onRestore}><History />Restore servers…</Button>
          <Button size="sm" variant="outline" onClick={() => setChangingPassphrase(true)}><KeyRound />Change passphrase…</Button>
          <Button size="sm" variant="outline" onClick={onMove} disabled={status.copying}><MoveRight />Move to another destination…</Button>
          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmOff(true)} disabled={status.copying}><Power />Turn off</Button>
        </div>
      </div>
    </Section>
    <PassphraseDialog open={changingPassphrase} onOpenChange={setChangingPassphrase} onDone={onChanged} />
    <ConfirmDialog open={confirmOff} onOpenChange={setConfirmOff} title="Turn off offsite backups?" confirmLabel="Turn off" destructive
      onConfirm={() => void track("offsite:off", async () => { await api("/api/offsite", { method: "DELETE" }); toast.success("Offsite backups are off."); onChanged(); })}>
      <p>New backups stay on this machine only. Copies already at {overview.label} are kept, and you can restore from them later with your passphrase.</p>
    </ConfirmDialog>
  </>;
}

export function OffsitePage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"view" | "setup" | "restore">("view");
  const load = useCallback(async () => {
    try { setOverview(await api<Overview>("/api/offsite")); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Couldn't load offsite backups.")); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  // Follow copies and restores while they run.
  const busy = overview?.status.copying || (overview?.restore && !overview.restore.finishedAt);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [busy, load]);
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("restore") === "1") { const timer = window.setTimeout(() => setMode("restore"), 0); return () => window.clearTimeout(timer); }
  }, []);

  return <div className="space-y-6">
    <PageHeading eyebrow="Backups" title="Offsite backups" description="Keep copies of every server somewhere else, so a dead disk or a lost machine doesn't take your worlds with it." />
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>}
    {!overview ? <Skeleton className="h-64" /> : <>
      {overview.restore && <RestoreProgress job={overview.restore} />}
      {mode === "restore" ? <RestoreForm overview={overview} onStarted={() => { setMode("view"); void load(); }} onCancel={() => setMode("view")} />
        : mode === "setup" || !overview.configured ? <>
          <SetupForm key={overview.configuredAt || "new"} overview={overview} onDone={() => { setMode("view"); void load(); }} onCancel={overview.configured ? () => setMode("view") : undefined} />
          {!overview.configured && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border p-4">
            <div><p className="text-sm font-medium">Moving to a new machine?</p><p className="mt-0.5 text-xs text-muted-foreground">Bring your servers back from an existing offsite backup with your passphrase.</p></div>
            <Button variant="outline" onClick={() => setMode("restore")}><History />Restore from an offsite backup</Button>
          </div>}
        </>
          : <StatusCard key={`${overview.schedule}-${overview.keep}`} overview={overview} onChanged={() => void load()} onMove={() => setMode("setup")} onRestore={() => setMode("restore")} />}
    </>}
  </div>;
}
