"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Dices, LoaderCircle, RefreshCcw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog, Section } from "../common";
import { ApiError, api, errorMessage, formatRelative, formChanges, fromServer, toPayload } from "../lib";
import { useNow, usePanel } from "../panel-context";
import { AdvancedFields, BasicFields, type FieldErrors, GameplayFields, PerformanceFields, validateForm } from "../server-form";
import type { MinecraftServer, ServerForm } from "../types";

/** Deletes the world and generates a new one (Minecraft only). No backup is taken. */
function RerollWorld({ server }: { server: MinecraftServer }) {
  const { track, isPending } = usePanel();
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState("");
  const busy = Boolean(server.operation) || isPending(`${server.id}:reroll`);
  const lastBackup = server.backup?.lastRunAt;
  async function reroll() {
    await track(`${server.id}:reroll`, async () => {
      const result = await api<{ message: string }>(`/api/servers/${server.id}/reroll`, { method: "POST", body: JSON.stringify({ seed: seed.trim() }) });
      toast.success(result.message, { description: "Stopping, deleting the world, and generating a new one. Progress shows at the top of the page." });
    });
  }
  return <>
    <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div><p className="text-sm font-medium">Re-roll the world</p><p className="mt-0.5 text-xs text-muted-foreground">Deletes the overworld, Nether, and End, then starts with a brand-new world. Plugins, mods, settings, the whitelist, and ops are kept.</p></div>
      <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-danger-soft hover:text-destructive" onClick={() => { setSeed(""); setOpen(true); }} disabled={busy}>{busy && isPending(`${server.id}:reroll`) ? <LoaderCircle className="animate-spin" /> : <Dices />}Re-roll world…</Button>
    </div>
    <ConfirmDialog open={open} onOpenChange={setOpen} destructive title={`Re-roll ${server.name}'s world?`} confirmLabel="Delete world and generate a new one" typeToConfirm={server.name} onConfirm={() => void reroll()}>
      <p>The server stops, its world is <span className="font-medium text-foreground">permanently deleted</span> (overworld, Nether, and End), and it starts again with a new one. <span className="font-medium text-foreground">No backup is taken.</span></p>
      <p>{lastBackup ? `The last backup was ${formatRelative(lastBackup, now)}.` : server.backupCount > 0 ? `This server has ${server.backupCount} backup${server.backupCount === 1 ? "" : "s"}.` : "This server has no backups yet."} To keep the current world, back up first from the Backups tab.</p>
      {server.playersOnline > 0 && <p>{server.playersOnline} player{server.playersOnline === 1 ? " is" : "s are"} online and will be disconnected after a {server.stopAnnounceDelaySeconds}s warning.</p>}
      <div className="grid gap-1.5 text-foreground">
        <Label htmlFor="reroll-seed">Seed <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <Input id="reroll-seed" value={seed} onChange={(event) => setSeed(event.target.value)} maxLength={64} placeholder="Leave empty for a random world" autoComplete="off" spellCheck={false} />
      </div>
    </ConfirmDialog>
  </>;
}

function RemoveServer({ server }: { server: MinecraftServer }) {
  const { track, isPending } = usePanel();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const removing = isPending(`${server.id}:remove`);
  const [purge, setPurge] = useState(false);
  async function remove() {
    await track(`${server.id}:remove`, async () => {
      await api(`/api/servers/${server.id}${purge ? "?purge=true" : ""}`, { method: "DELETE" });
      toast.success(purge ? `${server.name}, its world, and its backups were deleted.` : `${server.name} was removed. Its world and backups are kept under detached worlds.`);
      router.push("/servers");
    });
  }
  return <Section title={<span id="danger-zone" className="scroll-mt-24 text-destructive">Danger zone</span>} className="border-destructive/30">
    <div className="mb-4"><RerollWorld server={server} /></div>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div><p className="text-sm font-medium">Remove this server</p><p className="mt-0.5 text-xs text-muted-foreground">Deletes the container. You choose whether the world and backups are kept.</p></div>
      <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-danger-soft hover:text-destructive" onClick={() => { setPurge(false); setOpen(true); }} disabled={Boolean(server.operation) || removing}>{removing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}{removing ? "Removing…" : `Remove ${server.name}…`}</Button>
    </div>
    <ConfirmDialog open={open} onOpenChange={setOpen} destructive title={`Remove ${server.name}?`} confirmLabel={purge ? "Delete everything" : "Remove server"} typeToConfirm={purge ? server.name : undefined} onConfirm={() => void remove()}>
      <p>{purge ? "The container, the world, and every backup will be permanently deleted." : "The container is deleted. The world and backups stay on disk and can be reattached from All servers."}</p>
      {server.playersOnline > 0 && <p>{server.playersOnline} player{server.playersOnline === 1 ? " is" : "s are"} online and will be disconnected.</p>}
      <div className="flex items-start gap-3 rounded-lg border border-border p-3 text-foreground"><Checkbox id="purge-data" checked={purge} onCheckedChange={(value) => setPurge(value === true)} /><Label htmlFor="purge-data" className="font-normal leading-5">Also delete the world and all backups</Label></div>
    </ConfirmDialog>
  </Section>;
}

export function SettingsTab({ server }: { server: MinecraftServer }) {
  const { track, servers, isPending, can } = usePanel();
  const baseline = useMemo(() => fromServer(server), [server]);
  // `edits` holds the draft plus the server state it was based on; with no edits the form mirrors live settings.
  const [edits, setEdits] = useState<{ form: ServerForm; base: ServerForm } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  // Plugins or mods that won't load after a server type or version change; dropped when applying.
  const [dropping, setDropping] = useState<{ id: string; title: string }[]>([]);
  const form = edits?.form ?? baseline;
  const changes = edits ? formChanges(baseline, edits.form) : [];
  const dirty = changes.length > 0;
  const changedElsewhere = Boolean(edits && formChanges(edits.base, baseline).length);
  // Only the name changed: applied instantly, without a restart.
  const nameOnly = changes.length === 1 && changes[0].key === "name";
  const errors = { ...validateForm(form, servers, server.id), ...serverErrors };
  const hasErrors = Object.keys(errors).length > 0;
  const busy = Boolean(server.operation) || isPending(`${server.id}:settings`);

  function update(next: ServerForm) { setEdits({ form: next, base: edits?.base ?? baseline }); setServerErrors({}); }

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function review() {
    setDropping([]);
    const projects = server.modrinthProjects || [];
    if (projects.length && (form.type !== baseline.type || form.version !== baseline.version)) {
      try {
        const { incompatible } = await api<{ incompatible: { id: string; title: string }[] }>(`/api/servers/${server.id}/modrinth/compatibility?type=${encodeURIComponent(form.type)}&version=${encodeURIComponent(form.version)}`);
        setDropping(incompatible);
      } catch (error) { toast.error(errorMessage(error, "Couldn't check plugin compatibility with Modrinth. Try again.")); return; }
    }
    setReviewing(true);
  }

  async function apply() {
    const dropped = new Set(dropping.map((item) => item.id));
    const submitted = { ...form, modrinthProjects: form.modrinthProjects.filter((id) => !dropped.has(id)) };
    await track(`${server.id}:settings`, async () => {
      try {
        const result = await api<{ message: string; renamed?: boolean }>(`/api/servers/${server.id}`, { method: "PATCH", body: JSON.stringify(toPayload(submitted)) });
        if (result.renamed) toast.success(result.message);
        else toast.success("Applying settings", { description: "Backing up, recreating, and health-checking the server. It rolls back automatically if startup fails." });
        setEdits(null);
      } catch (error) {
        if (error instanceof ApiError && error.field) { setServerErrors({ [error.field]: error.message }); toast.error(error.message); }
        else throw new Error(errorMessage(error, "Configuration update failed."));
      }
    });
  }

  return <div className="space-y-5 pb-20">
    {changedElsewhere && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
      <TriangleAlert className="size-4 text-warning" /><p className="flex-1">These settings changed since you started editing (another admin or an update).</p>
      <Button size="sm" variant="outline" onClick={() => setEdits(null)}><RefreshCcw />Discard my edits and reload</Button>
    </div>}
    {!can.manage && <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">You can view these settings. Only admins can change them.</p>}
    <fieldset disabled={!can.manage} className="min-w-0 space-y-5">
    <Section title="General"><div className="grid gap-5 sm:grid-cols-2"><BasicFields form={form} setForm={update} errors={errors} idPrefix="edit" servers={servers} /></div></Section>
    <Section title="Gameplay" description="Applied each time the server starts."><div className="grid gap-5 sm:grid-cols-2"><GameplayFields form={form} setForm={update} errors={errors} idPrefix="edit" servers={servers} /></div></Section>
    <Section title="Performance" description="Applied each time the server is recreated."><div className="grid gap-5 sm:grid-cols-2"><PerformanceFields form={form} setForm={update} errors={errors} idPrefix="edit" servers={servers} /></div></Section>
    <div className="grid gap-5 sm:grid-cols-2"><AdvancedFields form={form} setForm={update} errors={errors} idPrefix="edit" servers={servers} /></div>
    </fieldset>
    {can.manage && <RemoveServer server={server} />}

    <div className={dirty ? "pb-safe fixed inset-x-0 bottom-14 z-30 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:bottom-0 lg:left-64" : "hidden"} role="region" aria-label="Unsaved changes">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 lg:px-4">
        <p className="text-sm"><span className="font-medium">{changes.length} unsaved change{changes.length === 1 ? "" : "s"}</span>{hasErrors && <span className="text-destructive"> · fix the highlighted fields</span>}</p>
        <div className="flex gap-2"><Button variant="ghost" onClick={() => { setEdits(null); setServerErrors({}); }}>Discard</Button><Button onClick={() => void review()} disabled={hasErrors || busy}>Review and apply</Button></div>
      </div>
    </div>
    <ConfirmDialog open={reviewing} onOpenChange={setReviewing} title={nameOnly ? `Rename ${server.name}?` : `Apply ${changes.length} change${changes.length === 1 ? "" : "s"} to ${server.name}?`} confirmLabel={nameOnly ? "Rename" : "Apply and restart"} onConfirm={() => void apply()}>
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-3 text-xs">
        {changes.map((change) => <li key={change.key}><span className="font-medium text-foreground">{change.label}</span>: <span className="line-through">{change.from}</span> → <span className="text-foreground">{change.to}</span></li>)}
      </ul>
      {dropping.length > 0 && <p className="rounded-lg border border-warning/30 bg-warning-soft p-2.5 text-warning">These have no build for {form.type === baseline.type ? "" : `${form.type.charAt(0)}${form.type.slice(1).toLowerCase()} `}{form.version} and will be removed: {dropping.map((item) => item.title).join(", ")}.</p>}
      {nameOnly ? <p>Renaming is instant. The server keeps running and nobody is disconnected.</p> : <>
        <p>The server restarts to apply these, usually taking 1–3 minutes.{server.playersOnline ? ` ${server.playersOnline} player${server.playersOnline === 1 ? " is" : "s are"} online and will be disconnected after a ${server.stopAnnounceDelaySeconds}s warning.` : ""}</p>
        <p>A safety backup is taken first, and if the server doesn&apos;t start, the previous settings are restored automatically.</p>
      </>}
    </ConfirmDialog>
  </div>;
}
