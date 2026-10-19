import { useCallback, useEffect, useState } from "react";
import { Archive, Download, LoaderCircle, Save, Unplug, Upload } from "lucide-react";
import { api, formatBytes, type State } from "./api";
import { Dialog, Field, run, Section } from "./ui";

type Status = { configured: boolean; description?: string; keep?: number; afterBackup?: boolean; servers: { id: string; name: string; incremental: boolean; lastCopyAt?: string; lastError?: string }[] };
type RecoveryServer = { id: string; name: string; type: string; version: string; lastCopyAt: string };
type Snapshot = { id: string; time: string; size: number; kind: string };

export function OffsitePage({ state }: { state: State }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const [kind, setKind] = useState<"folder" | "s3">("folder");
  const [form, setForm] = useState({ path: "", provider: "b2", bucket: "", prefix: "blocky", endpoint: "", region: "", accessKeyId: "", secretAccessKey: "" });
  const [passphrase, setPassphrase] = useState("");
  const [keep, setKeep] = useState(30);
  const [afterBackup, setAfterBackup] = useState(true);
  const [recovered, setRecovered] = useState<{ context: { destination: object; passphrase: string }; servers: RecoveryServer[] } | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotId, setSnapshotId] = useState("");
  const [localId, setLocalId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const load = useCallback(async () => {
    try { const data = await api<Status>("/api/offsite"); setStatus(data); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not read backup settings."); }
  }, []);
  useEffect(() => { void load(); const timer = setInterval(load, 10000); return () => clearInterval(timer); }, [load]);
  const destination = () => kind === "folder" ? { kind, path: form.path } : { kind, provider: form.provider, bucket: form.bucket, prefix: form.prefix, endpoint: form.endpoint, region: form.region, accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey };
  const change = (key: keyof typeof form, value: string) => { clearRecovery(); setForm((current) => ({ ...current, [key]: value })); };
  const source = recovered?.servers.find((server) => server.id === sourceId);
  const matching = state.servers.filter((server) => source && server.software.toUpperCase() === source.type && server.version === source.version);
  const local = matching.find((server) => server.id === localId);
  const localActive = local && ["installing", "starting", "running", "stopping"].includes(local.status);
  const clearRecovery = () => { setRecovered(null); setSnapshots([]); setSourceId(""); setSnapshotId(""); setLocalId(""); };
  return <div className="space-y-6">
    <div><h1 className="text-3xl font-bold tracking-[-.035em]">Off-site backups</h1><p className="mt-1 text-sm text-muted-foreground">Keep encrypted copies on another disk, a mounted network folder, or S3-compatible storage.</p></div>
    {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-danger-soft-foreground">{error}</p>}
    <Section title="Destination" description={status?.description || "No destination configured."} actions={<>
      <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => { setShowForm(!showForm); clearRecovery(); }}>Configure or recover</button>
      {(status?.configured || error) && <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => setDisconnect(true)}><Unplug />Disconnect</button>}
    </>}>
      {status?.configured ? <p className="text-sm text-muted-foreground">Keep {status.keep} copies per group. {status.afterBackup ? "Copies run after manual and scheduled incremental backups." : "Copies run when you choose Copy now."}</p> : <p className="text-sm text-muted-foreground">Choose a dedicated folder or bucket prefix. The recovery passphrase opens these backups on another machine; it is never stored by the panel.</p>}
    </Section>
    {(showForm || status?.configured === false) && <Section title="Set up a destination or recover an existing one" description="For a network share, mount or connect it in Windows first. S3-compatible endpoints use HTTPS.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Storage type"><select className="input" disabled={busy} value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); clearRecovery(); }}><option value="folder">Separate folder or network share</option><option value="s3">S3-compatible storage</option></select></Field>
        {kind === "folder" ? <Field label="Folder path"><input className="input" value={form.path} placeholder="C:\Backups\Blocky" onChange={(event) => change("path", event.target.value)} /></Field> : <>
          <Field label="Provider"><select className="input" value={form.provider} onChange={(event) => change("provider", event.target.value)}>{[["b2", "Backblaze B2"], ["r2", "Cloudflare R2"], ["wasabi", "Wasabi"], ["aws", "Amazon S3"], ["minio", "MinIO"], ["other", "Other S3-compatible"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="Bucket"><input className="input" value={form.bucket} onChange={(event) => change("bucket", event.target.value)} /></Field>
          <Field label="Prefix"><input className="input" value={form.prefix} onChange={(event) => change("prefix", event.target.value)} /></Field>
          <Field label="Region" hint="Use the region shown by your bucket provider."><input className="input" value={form.region} onChange={(event) => change("region", event.target.value)} /></Field>
          {["r2", "minio", "other"].includes(form.provider) && <Field label="HTTPS endpoint"><input className="input" value={form.endpoint} onChange={(event) => change("endpoint", event.target.value)} /></Field>}
          <Field label="Access key ID"><input className="input" autoComplete="off" value={form.accessKeyId} onChange={(event) => change("accessKeyId", event.target.value)} /></Field>
          <Field label="Secret access key"><input className="input" type="password" autoComplete="off" value={form.secretAccessKey} onChange={(event) => change("secretAccessKey", event.target.value)} /></Field>
        </>}
        <Field label="Recovery passphrase" hint="For new backups, use at least 20 characters or five words. Keep it somewhere safe."><input className="input" type="password" autoComplete="new-password" maxLength={1024} value={passphrase} onChange={(event) => { clearRecovery(); setPassphrase(event.target.value); }} /></Field>
        <Field label="Copies per group to keep"><input className="input" type="number" min={1} max={500} value={keep} onChange={(event) => setKeep(Number(event.target.value))} /></Field>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={afterBackup} onChange={(event) => setAfterBackup(event.target.checked)} />Copy after each manual or scheduled incremental backup</label>
      <div className="mt-5 flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy || !passphrase} onClick={() => { setBusy(true); void run(async () => { await api("/api/offsite", { method: "PUT", body: { destination: destination(), passphrase, keep, afterBackup } }); setPassphrase(""); change("secretAccessKey", ""); setShowForm(false); clearRecovery(); await load(); }, "Off-site destination configured.").finally(() => setBusy(false)); }}>{busy ? <LoaderCircle className="animate-spin" /> : <Save />}Configure for new copies</button>
        <button className="btn btn-outline" disabled={busy || !passphrase} onClick={() => { setBusy(true); void run(async () => { const context = { destination: destination(), passphrase }; const data = await api<{ servers: RecoveryServer[] }>("/api/offsite/discover", { method: "POST", body: context }); clearRecovery(); setRecovered({ context, servers: data.servers }); }).finally(() => setBusy(false)); }}><Download />Find existing backups</button>
      </div>
    </Section>}
    {status?.configured && <Section title="Copy server backups" description="Enable encrypted incremental storage in each server's Backups settings first. Copy now creates a fresh local snapshot, then sends encrypted changes.">
      <ul className="divide-y divide-border">{status.servers.map((server) => <li key={server.id} className="flex flex-wrap items-center gap-3 py-4 text-sm">
        <Archive className="size-5 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-semibold">{server.name}</p><p className="mt-1 text-xs text-muted-foreground">{!server.incremental ? "Choose encrypted incremental storage in Backups." : server.lastCopyAt ? `Last copy: ${new Date(server.lastCopyAt).toLocaleString()}` : "No off-site copy yet."}</p>{server.lastError && <p className="mt-1 text-xs text-destructive">{server.lastError}</p>}</div>
        <button className="btn btn-outline btn-sm" disabled={busy || !server.incremental || !!state.servers.find((item) => item.id === server.id)?.operation} onClick={() => { setBusy(true); void run(async () => { await api(`/api/servers/${server.id}/offsite-copy`, { method: "POST" }); await load(); }, "Encrypted backups copied off-site.").finally(() => setBusy(false)); }}><Upload />Copy now</button>
      </li>)}</ul>
    </Section>}
    {recovered && <Section title="Recover existing backups" description="Restore into a stopped local server with the same server software and Minecraft version. Your current local data is backed up first.">
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Backup server"><select className="input" value={sourceId} disabled={busy} onChange={(event) => {
        const serverId = event.target.value; setSourceId(serverId); setSnapshots([]); setSnapshotId(""); setLocalId("");
        if (serverId) { setBusy(true); void run(async () => { const data = await api<{ snapshots: Snapshot[] }>("/api/offsite/snapshots", { method: "POST", body: { ...recovered.context, serverId } }); setSnapshots(data.snapshots); setSnapshotId(data.snapshots[0]?.id || ""); }).finally(() => setBusy(false)); }
      }}><option value="">Choose a backup server</option>{recovered.servers.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.type} {server.version}</option>)}</select></Field>
        <Field label="Snapshot"><select className="input" value={snapshotId} disabled={!snapshots.length || busy} onChange={(event) => setSnapshotId(event.target.value)}>{!snapshots.length && <option>No snapshots selected</option>}{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{new Date(snapshot.time).toLocaleString()} · {snapshot.kind} · {formatBytes(snapshot.size)}</option>)}</select></Field>
        <Field label="Local server to replace"><select className="input" value={localId} disabled={!matching.length || busy} onChange={(event) => setLocalId(event.target.value)}><option value="">Choose a local server</option>{matching.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.status}</option>)}</select></Field>
      </div>
      {source && !matching.length && <p className="mt-3 text-sm text-muted-foreground">Create a local {source.type} {source.version} server first, then return here to select it.</p>}
      {localActive && <p className="mt-3 text-sm text-muted-foreground">Stop the selected local server before restoring.</p>}
      <button className="btn btn-primary mt-5" disabled={!local || !snapshotId || busy || localActive || !!local.operation} onClick={() => { setConfirmName(""); setConfirming(true); }}><Download />Restore selected snapshot</button>
    </Section>}
    {disconnect && <Dialog title="Disconnect off-site backups?" onClose={() => { if (!busy) setDisconnect(false); }} footer={<><button className="btn btn-outline" disabled={busy} onClick={() => setDisconnect(false)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => { setBusy(true); void run(async () => { await api("/api/offsite", { method: "DELETE" }); setDisconnect(false); clearRecovery(); await load(); }, "Destination disconnected; existing off-site backups were kept.").finally(() => setBusy(false)); }}>Disconnect</button></>}><p className="text-sm text-muted-foreground">Future copies stop and saved connection settings are removed from this panel. Existing off-site backups remain where they are and can be opened with your recovery passphrase.</p></Dialog>}
    {confirming && local && recovered && <Dialog title={`Replace ${local.name} from off-site?`} onClose={() => { if (!busy) setConfirming(false); }} footer={<><button className="btn btn-outline" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button><button className="btn btn-primary" disabled={busy || confirmName !== local.name} onClick={() => { setBusy(true); void run(async () => { await api(`/api/servers/${local.id}/offsite-restore`, { method: "POST", body: { ...recovered.context, serverId: sourceId, snapshotId, confirmName } }); setConfirming(false); setPassphrase(""); clearRecovery(); await load(); }, "Off-site snapshot restored. Start the server when ready.").finally(() => setBusy(false)); }}>{busy ? <LoaderCircle className="animate-spin" /> : <Download />}Restore</button></>}><p className="mb-4 text-sm text-muted-foreground">This replaces the local server files with the selected snapshot. A safety backup of the current local data is kept.</p><Field label={`Type ${local.name} to confirm`}><input className="input" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} /></Field></Dialog>}
  </div>;
}
