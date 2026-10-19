import { useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Map, RotateCcw, Upload } from "lucide-react";
import { api, formatBytes, type Server } from "./api";
import { Dialog, Field, pushToast, run, Section } from "./ui";

export function WorldTab({ server }: { server: Server }) {
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState<{ seed: string; mapUrl: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [nextSeed, setNextSeed] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const active = ["installing", "starting", "running", "stopping"].includes(server.status);
  const prefix = `/api/servers/${server.id}`;
  return <div className="space-y-6">
    <Section title="World seed" description="Ask the running server for its actual seed, including a world you imported."
      actions={<button className="btn btn-outline btn-sm" disabled={server.status !== "running" || busy} onClick={() => { setBusy(true); void run(async () => { setSeed(await api<{ seed: string; mapUrl: string }>(`${prefix}/seed`, { method: "POST" })); }).finally(() => setBusy(false)); }}><Map />Read seed</button>}>
      {seed ? <div className="flex flex-wrap items-center gap-3"><code className="text-sm">{seed.seed}</code><a className="btn btn-outline btn-sm" href={seed.mapUrl} target="_blank" rel="noreferrer"><ExternalLink />Open seed map</a></div> : <p className="text-sm text-muted-foreground">{server.status === "running" ? "Read the seed to open its map on Chunkbase." : "Start the server to read its seed."}</p>}
    </Section>
    <Section title="Import a Java world" description="Upload a ZIP, TAR, or TAR.GZ archive containing level.dat. Maximum upload: 4 GB. A safety backup of your current worlds is made before replacement.">
      <input ref={upload} type="file" accept=".zip,.tar,.gz,.tgz" className="hidden" aria-label="Choose a world archive" onChange={(event) => { const selected = event.target.files?.[0]; event.target.value = ""; if (selected) { if (selected.size > 4 * 1024 ** 3) pushToast("World archives must be at most 4 GB.", "error"); else setFile(selected); } }} />
      <button className="btn btn-primary" disabled={active || busy || !!server.operation} onClick={() => upload.current?.click()}><Upload />Choose world archive</button>
      {active && <p className="mt-3 text-xs text-muted-foreground">Stop the server before importing or resetting its world.</p>}
      <p className="mt-3 text-xs text-muted-foreground">Bedrock worlds need conversion to Java before import. Paper/Purpur sibling Nether and End folders are preserved when included in the archive.</p>
    </Section>
    <Section title="Reset the world" description="Generate a fresh world on the next start. Existing Overworld, Nether, and End data is saved in a safety backup first.">
      <button className="btn btn-stop" disabled={active || busy || !!server.operation} onClick={() => { setNextSeed(""); setConfirmName(""); setResetting(true); }}><RotateCcw />Reset world</button>
    </Section>
    {file && <Dialog title="Replace the current world?" onClose={() => { if (!busy) setFile(null); }} footer={<><button className="btn btn-outline" disabled={busy} onClick={() => setFile(null)}>Cancel</button><button className="btn btn-primary" disabled={busy || active} onClick={() => {
      setBusy(true);
      void run(async () => {
        const response = await fetch(`${prefix}/world/import?filename=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "x-blocky-request": "1", "Content-Type": "application/octet-stream" }, body: file });
        if (!response.ok) { const error = await response.json(); throw new Error(error.error || "World import failed."); }
        setFile(null); setSeed(null);
        pushToast("World imported. Start the server to load it.");
      }).finally(() => setBusy(false));
    }}>{busy ? <LoaderCircle className="animate-spin" /> : <Upload />}{busy ? "Importing…" : "Import world"}</button></>}>
      <p className="break-all text-sm font-medium">{file.name} · {formatBytes(file.size)}</p><p className="mt-3 text-sm text-muted-foreground">This replaces the current worlds. Server software, plugins, and settings stay in place. You can restore your previous worlds from the safety backup in Backups.</p>
    </Dialog>}
    {resetting && <Dialog title="Reset all dimensions?" onClose={() => { if (!busy) setResetting(false); }} footer={<><button className="btn btn-outline" disabled={busy} onClick={() => setResetting(false)}>Cancel</button><button className="btn btn-danger" disabled={busy || active || confirmName !== server.name} onClick={() => {
      setBusy(true); void run(async () => { await api(`${prefix}/world/reset`, { method: "POST", body: { seed: nextSeed, confirmName } }); setResetting(false); setSeed(null); }, "World reset. Start the server to generate the new world.").finally(() => setBusy(false));
    }}>{busy ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}Reset world</button></>}>
      <div className="grid gap-4"><Field label="New seed" hint="Leave empty for a random world."><input className="input" maxLength={64} value={nextSeed} onChange={(event) => setNextSeed(event.target.value)} /></Field><Field label={`Type ${server.name} to confirm`}><input className="input" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} /></Field></div>
    </Dialog>}
  </div>;
}
