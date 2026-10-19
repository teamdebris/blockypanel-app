import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Download, ExternalLink, LoaderCircle, Package, Search, Trash2 } from "lucide-react";
import type { InstalledAddon } from "../server/control";
import type { AddonPlan } from "../server/modrinth";
import { api, formatBytes, type Server } from "./api";
import { Dialog, run, Section } from "./ui";

type Hit = { id: string; title: string; description: string; downloads: number; projectUrl: string };
export function AddonsTab({ server }: { server: Server }) {
  const [installed, setInstalled] = useState<InstalledAddon[] | null>(null);
  const [otherFiles, setOtherFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searched, setSearched] = useState("");
  const [optional, setOptional] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<{ value: AddonPlan; id: string; title: string; optional: boolean } | null>(null);
  const [removing, setRemoving] = useState<InstalledAddon | null>(null);
  const active = ["installing", "starting", "running", "stopping"].includes(server.status);
  const prefix = `/api/servers/${server.id}/modrinth`;
  const label = server.software === "paper" || server.software === "purpur" ? "Plugins" : "Mods";
  const load = useCallback(async () => {
    if (server.software === "vanilla") return;
    try { const result = await api<{ installed: InstalledAddon[]; otherFiles: string[] }>(`/api/servers/${server.id}/modrinth`); setInstalled(result.installed); setOtherFiles(result.otherFiles); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not load installed projects."); }
  }, [server.id, server.software, active]);
  useEffect(() => { void load(); }, [load]);
  const search = async (value: string, start = 0) => {
    setSearching(true); setError("");
    try { const data = await api<{ hits: Hit[]; total: number }>(`${prefix}/search?q=${encodeURIComponent(value)}&offset=${start}`); setHits(data.hits); setTotal(data.total); setOffset(start); setSearched(value); }
    catch (error) { setError(error instanceof Error ? error.message : "Search failed."); }
    finally { setSearching(false); }
  };
  const preview = async (id: string, title: string, includeOptional = optional) => {
    setBusy(true);
    await run(async () => { const value = await api<AddonPlan>(`${prefix}/plan`, { method: "POST", body: { projectId: id, optionalDependencies: includeOptional } }); setPlan({ value, id, title, optional: includeOptional }); });
    setBusy(false);
  };
  if (server.software === "vanilla") return <Section title="Plugins and mods"><p className="text-sm text-muted-foreground">Vanilla does not load plugins or mods. Create a Paper/Purpur server for plugins, or Fabric, Quilt, Forge, or NeoForge for mods.</p></Section>;
  return <div className="space-y-6">
    {active && <p className="rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">Stop the server to install, update, or remove {label.toLowerCase()}. You can search while it runs.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Section title={`Installed ${label.toLowerCase()}`} description="Managed projects keep their compatible versions and dependencies together. Changes create a safety backup first.">
      {installed === null ? <p className="text-sm text-muted-foreground">Loading…</p> : !installed.length ? <p className="text-sm text-muted-foreground">No managed projects installed yet.</p>
        : <ul className="divide-y divide-border">{installed.map((addon) => <li key={addon.projectId} className="flex flex-wrap items-center gap-3 py-3 text-sm">
          <Package className="size-5 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-semibold">{addon.title} {!addon.requested && <span className="ml-2 rounded-full border border-border px-2 py-px text-xs font-normal text-muted-foreground">Dependency</span>}</p><p className="mt-1 break-all text-xs text-muted-foreground">{addon.version}</p></div>
          {addon.requested && <button className="btn btn-outline btn-sm" disabled={active || busy || !!server.operation} onClick={() => void preview(addon.projectId, addon.title, addon.optionalDependencies)}><ArrowUpCircle />Check update</button>}
          <button className="btn btn-ghost btn-sm" aria-label={`Remove ${addon.title}`} disabled={active || busy || !!server.operation} onClick={() => setRemoving(addon)}><Trash2 /></button>
        </li>)}</ul>}
      {otherFiles.length > 0 && <div className="mt-5 border-t border-border pt-4"><p className="text-xs font-medium text-muted-foreground">Other JARs, uploaded manually</p><ul className="mt-2 space-y-1 font-mono text-xs">{otherFiles.map((file) => <li key={file} className="break-all">{file}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">Manage these in Files. They are preserved when Modrinth projects change.</p></div>}
    </Section>
    <Section title={`Find ${label.toLowerCase()} on Modrinth`} description={`Results match ${server.software} and Minecraft ${server.version}; client-only projects are excluded.`}>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void search(query); }}><input className="input" aria-label={`Search ${label.toLowerCase()}`} maxLength={100} placeholder={`Search ${label.toLowerCase()}`} value={query} onChange={(event) => setQuery(event.target.value)} /><button className="btn btn-primary" disabled={searching}>{searching ? <LoaderCircle className="animate-spin" /> : <Search />}Search</button></form>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={optional} onChange={(event) => setOptional(event.target.checked)} />Also include optional dependencies</label>
      <p className="mt-1 text-xs text-muted-foreground">Required dependencies are always included. Only compatible stable releases are installed.</p>
      {hits !== null && <div className="mt-5">{!hits.length ? <p className="text-sm text-muted-foreground">No matching projects found.</p> : <ul className="divide-y divide-border">{hits.map((hit) => <li key={hit.id} className="flex items-start gap-3 py-4">
        <Package className="mt-0.5 size-5 shrink-0 text-primary" /><div className="min-w-0 flex-1"><a className="inline-flex items-center gap-1 text-sm font-semibold hover:underline" href={hit.projectUrl} target="_blank" rel="noreferrer">{hit.title}<ExternalLink className="size-3" /></a><p className="mt-1 text-sm text-muted-foreground">{hit.description}</p><p className="mt-1 text-xs text-muted-foreground">{hit.downloads.toLocaleString()} downloads</p></div>
        <button className="btn btn-outline btn-sm" disabled={active || busy || !!server.operation} onClick={() => void preview(hit.id, hit.title)}><Download />Preview</button>
      </li>)}</ul>}
        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground"><span>{total.toLocaleString()} results</span><div className="flex gap-2"><button className="btn btn-outline btn-sm" disabled={!offset || searching} onClick={() => void search(searched, Math.max(0, offset - 20))}>Previous</button><button className="btn btn-outline btn-sm" disabled={offset + 20 >= total || searching || offset >= 10000} onClick={() => void search(searched, offset + 20)}>Next</button></div></div>
      </div>}
    </Section>
    {plan && <Dialog title={`Install or update ${plan.title}?`} onClose={() => { if (!busy) setPlan(null); }} footer={<><button className="btn btn-outline" disabled={busy} onClick={() => setPlan(null)}>Cancel</button><button className="btn btn-primary" disabled={busy || active} onClick={() => { setBusy(true); void run(async () => { await api(`${prefix}/install`, { method: "POST", body: { projectId: plan.id, optionalDependencies: plan.optional, expectedPlan: plan.value.fingerprint } }); setPlan(null); await load(); }, "Projects installed. Start the server to load them.").finally(() => setBusy(false)); }}>{busy ? <LoaderCircle className="animate-spin" /> : <Download />}Apply</button></>}>
      <div className="max-h-72 space-y-3 overflow-y-auto text-sm">
        {([['Add', plan.value.added], ['Update', plan.value.updated], ['Remove unused dependency', plan.value.removed]] as const).map(([title, projects]) => projects.length > 0 && <div key={title}><p className="font-semibold">{title}</p><ul className="mt-1 space-y-1 text-muted-foreground">{projects.map((project) => <li key={`${project.title}/${project.version}`}>{project.title} · {project.version}</li>)}</ul></div>)}
        {!plan.value.added.length && !plan.value.updated.length && !plan.value.removed.length && <p>The compatible versions are already installed. Applying saves your dependency preferences.</p>}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Download: {formatBytes(plan.value.downloadBytes)}. A safety backup is made before JAR files change. Plugins and mods run as your Windows account.</p>
    </Dialog>}
    {removing && <Dialog title={`Remove ${removing.title}?`} onClose={() => { if (!busy) setRemoving(null); }} footer={<><button className="btn btn-outline" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button><button className="btn btn-danger" disabled={busy} onClick={() => { setBusy(true); void run(async () => { await api(`${prefix}/${removing.projectId}`, { method: "DELETE" }); setRemoving(null); await load(); }, "Project selection updated.").finally(() => setBusy(false)); }}>Remove</button></>}>
      <p className="text-sm text-muted-foreground">Unused managed dependencies are removed too. Projects still needed by other selections, manually uploaded JARs, and configuration folders are kept. A safety backup is made first.</p>
    </Dialog>}
  </div>;
}
