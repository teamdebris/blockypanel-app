"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpCircle, Check, ExternalLink, LoaderCircle, Plus, Puzzle, RotateCcw, Search, TriangleAlert, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { MAX_MODRINTH_PROJECTS, type ModrinthTarget, projectListChanges } from "@/lib/modrinth-core";
import { cn } from "@/lib/utils";
import { PORT_PRESETS } from "@/lib/ports";
import { ConfirmDialog, Section } from "../common";
import { api, errorMessage, formatBytes, fromServer, serverHref, serverTypes, toPayload } from "../lib";
import { usePanel } from "../panel-context";
import type { MinecraftServer } from "../types";

type Project = { id: string; slug: string; title: string; description: string; iconUrl: string | null; downloads: number; author?: string; projectUrl: string };
type Installed = Project & { installed?: { version: string; file: string }; update?: string; compatible: boolean; available: boolean };
type OtherJar = { file: string; size: number; project?: { title: string; projectUrl: string } };
type TabData = { target: ModrinthTarget | null; projects: Installed[]; other: OtherJar[] };
type PickStatus = "ok" | "no-files" | "no-release" | "unavailable";
type Dependency = { id: string; title: string; projectUrl: string; status: PickStatus; version?: string };
type ProjectPlan = { status: PickStatus; version?: string; installs: Dependency[]; optional: Dependency[]; conflicts: Dependency[] };
type Plan = { exact: boolean; gameVersion?: string; projects: Record<string, ProjectPlan> };

/** Why a project on the list will stop the server starting, or undefined when it won't. */
function blocker(plan: ProjectPlan | undefined, where: string) {
  if (!plan) return undefined;
  if (plan.status === "unavailable") return "No longer available on Modrinth. Remove it, or the server won't start.";
  if (plan.status === "no-files") return `No file for ${where}. Remove it, or the server won't start.`;
  if (plan.status === "no-release") return `Only beta or alpha files for ${where}, and the server installs releases only. Remove it, or the server won't start.`;
  const missing = plan.installs.filter((dependency) => dependency.status !== "ok");
  if (missing.length) return `Needs ${listNames(missing)}, which ${missing.length === 1 ? "has" : "have"} no release for ${where}. The server won't start.`;
  return undefined;
}

function listNames(items: { title: string }[]) {
  const titles = items.map((item) => item.title);
  return titles.length <= 1 ? titles.join("") : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function ProjectIcon({ url, className }: { url: string | null; className?: string }) {
  return <span className={cn("grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted", className)} aria-hidden>
    {/* Remote icons from Modrinth's CDN; next/image would need a remote-pattern and adds nothing here. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {url ? <img src={url} alt="" loading="lazy" className="size-full object-cover" /> : <Puzzle className="size-5 text-muted-foreground" />}
  </span>;
}

function SearchResults({ server, target, selected, onAdd }: { server: MinecraftServer; target: ModrinthTarget; selected: string[]; onAdd: (project: Project) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ hits: Project[]; total: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    // Debounced so typing doesn't send a request per keystroke (Modrinth allows ~300 a minute).
    const timer = window.setTimeout(() => {
      setLoading(true);
      api<{ hits: Project[]; total: number }>(`/api/servers/${server.id}/modrinth/search?q=${encodeURIComponent(query)}`)
        .then((next) => { setResults(next); setError(""); })
        .catch((reason) => setError(errorMessage(reason, "Search failed.")))
        .finally(() => setLoading(false));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [query, server.id]);
  const noun = target.kind === "plugin" ? "plugins" : "mods";
  return <Section title={`Find ${noun}`} description={`From Modrinth, filtered to ${noun} that run on ${serverTypes.find((item) => item.value === server.type)?.label || server.type} ${/^\d/.test(server.version) ? server.version : server.runningVersion || server.version}.`}>
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${noun}, e.g. ${target.kind === "plugin" ? "LuckPerms" : "Lithium"}`} aria-label={`Search ${noun}`} className="pl-9" />
      {loading && <LoaderCircle className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Searching" />}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {!results && !error ? <div className="mt-3 space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      : results && <>
        {!query && <p className="mt-3 text-xs text-muted-foreground">Most downloaded</p>}
        {results.hits.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No {noun} match &quot;{query}&quot; for this server.</p>}
        <ul className="-mx-4 mt-2 divide-y divide-border sm:-mx-5">
          {results.hits.map((project) => {
            const added = selected.includes(project.id);
            return <li key={project.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <ProjectIcon url={project.iconUrl} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm"><a href={project.projectUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">{project.title}</a>{project.author && <span className="text-xs text-muted-foreground">by {project.author}</span>}</p>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{project.description}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{compact(project.downloads)} downloads</p>
              </div>
              <Button size="sm" variant={added ? "ghost" : "outline"} disabled={added} onClick={() => onAdd(project)} aria-label={added ? `${project.title} is on the list` : `Add ${project.title}`}>{added ? <><Check />Added</> : <><Plus />Add</>}</Button>
            </li>;
          })}
        </ul>
      </>}
  </Section>;
}

export function PluginsTab({ server }: { server: MinecraftServer }) {
  const { can, track, isPending, runAction } = usePanel();
  const [data, setData] = useState<TabData | null>(null);
  const [error, setError] = useState("");
  // Pending edits to the list, applied together with one restart.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [names, setNames] = useState<Record<string, Project>>({});
  const [reviewing, setReviewing] = useState(false);
  const [optionalDraft, setOptionalDraft] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const saved = useMemo(() => server.modrinthProjects || [], [server.modrinthProjects]);
  const list = draft ?? saved;
  const savedKey = saved.join(",");
  const listKey = list.join(",");
  const savedOptional = server.modrinthOptionalDependencies ?? false;
  const optional = optionalDraft ?? savedOptional;

  const load = useCallback(async () => {
    try { setData(await api<TabData>(`/api/servers/${server.id}/modrinth`)); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Couldn't load the list.")); }
  }, [server.id]);
  // Reload when the saved list changes (after applying) or the server restarts (the image installs on start).
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, savedKey, server.status]);
  // What the list (with unsaved edits) will download. Debounced so adding several in a row sends one request.
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      // Admin-only, like search: it serves editing the list.
      if (!can.manage) return;
      if (!listKey) { setPlan({ exact: true, projects: {} }); return; }
      api<Plan>(`/api/servers/${server.id}/modrinth/dependencies?ids=${listKey}&optional=${optional}`)
        .then((next) => { if (current) setPlan(next); })
        // The list still works without it; rows fall back to the simpler compatibility check.
        .catch(() => { if (current) setPlan(null); });
    }, 400);
    return () => { current = false; window.clearTimeout(timer); };
  }, [can.manage, server.id, listKey, optional, server.runningVersion]);

  const known = useMemo(() => ({ ...Object.fromEntries((data?.projects || []).map((project) => [project.id, project])), ...names }), [data, names]);
  const changes = projectListChanges(saved, list, Object.fromEntries(Object.entries(known).map(([id, project]) => [id, project.title])));
  const optionalChanged = optional !== savedOptional;
  const dirty = changes.added.length + changes.removed.length > 0 || optionalChanged;
  const busy = Boolean(server.operation) || isPending(`${server.id}:settings`);
  const target = data?.target;
  const noun = target?.kind === "plugin" ? "plugins" : "mods";
  // Map and voice plugins being added whose port isn't open yet: applying opens it in the same restart.
  const openingPorts = Object.values(PORT_PRESETS).filter((preset) => list.includes(preset.modrinth) && !saved.includes(preset.modrinth)
    && !(server.extraPorts ?? []).some((entry) => entry.preset === preset.id || (entry.target === preset.target && entry.protocol === preset.protocol)));

  function add(project: Project) {
    if (list.length >= MAX_MODRINTH_PROJECTS) { toast.error(`At most ${MAX_MODRINTH_PROJECTS} ${noun} per server.`); return; }
    setNames((current) => ({ ...current, [project.id]: project }));
    setDraft([...list, project.id]);
  }
  function remove(id: string) { setDraft(list.filter((item) => item !== id)); }

  async function apply() {
    const next = list;
    await track(`${server.id}:settings`, async () => {
      await api(`/api/servers/${server.id}`, { method: "PATCH", body: JSON.stringify(toPayload({ ...fromServer(server), modrinthProjects: next, modrinthOptionalDependencies: optional })) });
      toast.success(`Applying ${noun}`, { description: "Backing up, then restarting so the server downloads them. It rolls back automatically if startup fails." });
      setDraft(null);
      setOptionalDraft(null);
    });
  }

  if (error) return <p role="alert" className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>;
  if (!data) return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (!target) return <div className="rounded-xl border border-dashed border-border p-8 text-center">
    <Puzzle className="mx-auto size-6 text-muted-foreground" />
    <p className="mt-3 font-medium">Vanilla doesn&apos;t load plugins or mods</p>
    <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Change the server type to Paper or Purpur for plugins, or to Fabric, Quilt, Forge, or NeoForge for mods.{can.viewSettings ? "" : " An admin can change it."}</p>
    {can.manage && <Button asChild variant="outline" className="mt-4"><Link href={`${serverHref(server.id, "settings")}`}>Open settings</Link></Button>}
  </div>;

  const byId = new Map(data.projects.map((project) => [project.id, project]));
  const rows = list.map((id) => byId.get(id) || { ...(known[id] || { id, slug: id, title: id, description: "", iconUrl: null, downloads: 0, projectUrl: "" }), compatible: true, available: true } as Installed);
  const updates = data.projects.filter((project) => project.update && saved.includes(project.id));
  const typeLabel = serverTypes.find((item) => item.value === server.type)?.label || server.type;
  const where = plan?.exact && plan.gameVersion ? `${typeLabel} ${plan.gameVersion}` : typeLabel;
  const blocked = list.map((id) => ({ id, title: (byId.get(id) || known[id])?.title || id, reason: blocker(plan?.projects[id], where) })).filter((item) => item.reason);
  // Everything the added projects bring with them, for the review.
  const alsoDownloads = [...new Map(changes.added.length ? list.filter((id) => !saved.includes(id)).flatMap((id) => plan?.projects[id]?.installs || []).map((dependency) => [dependency.id, dependency]) : []).values()];

  return <div className="space-y-5 pb-20">
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Section title={`${target.label} from Modrinth`} description={`Installed into ${target.folder}/ when the server starts, with any required dependencies. They update to the newest compatible release on every restart.`}
          actions={updates.length > 0 && can.control && !dirty ? <Button size="sm" variant="outline" disabled={busy || server.status !== "running"} onClick={() => void runAction(server, "restart")}><RotateCcw />Restart to update {updates.length}</Button> : undefined}>
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">None yet.{can.manage ? ` Search for ${noun} to add them.` : ""}</p>
            : <ul className="-mx-4 -my-2 divide-y divide-border sm:-mx-5">
              {rows.map((project) => {
                const pendingAdd = !saved.includes(project.id);
                const projectPlan = plan?.projects[project.id];
                const problem = blocker(projectPlan, where) ?? (!project.available ? "No longer available on Modrinth. Remove it, or the server won't start." : !projectPlan && !project.compatible ? "No build for this server type and version. Remove it, or the server won't start." : undefined);
                return <li key={project.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <ProjectIcon url={project.iconUrl} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      {project.projectUrl ? <a href={project.projectUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">{project.title}</a> : <span className="font-medium">{project.title}</span>}
                      {pendingAdd && <span className="rounded-full border border-success/40 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-success">To add</span>}
                      {project.update && !pendingAdd && <span className="inline-flex items-center gap-1 text-xs text-warning"><ArrowUpCircle className="size-3.5" />{project.update} on restart</span>}
                    </p>
                    <p className={cn("mt-0.5 text-xs", problem ? "text-destructive" : "truncate text-muted-foreground")}>
                      {problem
                        || (pendingAdd ? `Downloads when you apply${projectPlan?.version ? ` (${projectPlan.version})` : ""}.`
                          : project.installed ? `${project.installed.version} · ${project.installed.file}` : server.status === "running" ? "Not found in the folder yet. It downloads on the next start." : "Downloads when the server starts.")}
                    </p>
                    {projectPlan && projectPlan.installs.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">Also installs {listNames(projectPlan.installs)}</p>}
                    {projectPlan && projectPlan.optional.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">Optional: {listNames(projectPlan.optional)}</p>}
                    {projectPlan && projectPlan.conflicts.length > 0 && <p className="mt-0.5 text-xs text-warning">Doesn&apos;t work with {listNames(projectPlan.conflicts)}</p>}
                  </div>
                  {problem && <TriangleAlert className="size-4 shrink-0 text-destructive" aria-label="Won't load" />}
                  {can.manage && <Button size="icon-sm" variant="ghost" onClick={() => remove(project.id)} aria-label={`Remove ${project.title}`}><X /></Button>}
                </li>;
              })}
            </ul>}
          {changes.removed.length > 0 && <p className="mt-4 text-xs text-muted-foreground">To remove: {changes.removed.join(", ")}. Their files are deleted on the next start.</p>}
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <Label htmlFor="optional-dependencies" className="flex-1 flex-col items-start gap-0.5 font-normal leading-5">
              <span className="block font-medium">Also install optional dependencies</span>
              <span className="block text-xs text-muted-foreground">Extra {noun} that add features to the ones on the list. If one has no file for this version, the server won&apos;t start.</span>
            </Label>
            <Switch id="optional-dependencies" checked={optional} disabled={!can.manage} onCheckedChange={(checked) => setOptionalDraft(checked === savedOptional ? null : checked)} />
          </div>
        </Section>
        {data.other.length > 0 && <Section title="Other files" description={`Jars in ${target.folder}/ that aren't on the list: dependencies the server downloaded for you, and anything added by hand. Manage them in Files.`}>
          <ul className="space-y-2 text-sm">
            {data.other.map((jar) => <li key={jar.file} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-xs">{jar.file}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{jar.project ? <a href={jar.project.projectUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">{jar.project.title}<ExternalLink className="size-3" /></a> : "Added by hand"} · {formatBytes(jar.size)}</span>
            </li>)}
          </ul>
          {can.files && <Button asChild size="sm" variant="outline" className="mt-4"><Link href={`${serverHref(server.id, "files")}?path=${target.folder}`}>Open {target.folder}/ in Files</Link></Button>}
        </Section>}
      </div>
      {can.manage && <SearchResults server={server} target={target} selected={list} onAdd={add} />}
    </div>

    <div className={dirty ? "pb-safe fixed inset-x-0 bottom-14 z-30 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:bottom-0 lg:left-64" : "hidden"} role="region" aria-label="Unsaved changes">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 lg:px-4">
        <p className="text-sm"><span className="font-medium">{[changes.added.length ? `${changes.added.length} to add` : "", changes.removed.length ? `${changes.removed.length} to remove` : "", optionalChanged ? `optional dependencies ${optional ? "on" : "off"}` : ""].filter(Boolean).join(", ")}</span><span className="text-muted-foreground"> · applied with one restart</span></p>
        <div className="flex gap-2"><Button variant="ghost" onClick={() => setDraft(null)}><Undo2 />Discard</Button><Button onClick={() => setReviewing(true)} disabled={busy}>Review and apply</Button></div>
      </div>
    </div>
    <ConfirmDialog open={reviewing} onOpenChange={setReviewing} title={`Update ${server.name}'s ${noun}?`} confirmLabel="Apply and restart" onConfirm={() => void apply()}>
      {blocked.length > 0 && <p className="rounded-lg border border-destructive/30 bg-danger-soft p-2.5 text-destructive">{listNames(blocked)} won&apos;t load, so the server won&apos;t start with this list. If you apply anyway, the previous setup is restored automatically.</p>}
      {changes.added.length > 0 && <p><span className="font-medium text-foreground">Add:</span> {changes.added.join(", ")}</p>}
      {alsoDownloads.length > 0 && <p><span className="font-medium text-foreground">Also downloads:</span> {alsoDownloads.map((dependency) => dependency.title).join(", ")}</p>}
      {optionalChanged && <p><span className="font-medium text-foreground">Optional dependencies:</span> {optional ? "installed from now on" : "no longer installed"}</p>}
      {changes.removed.length > 0 && <p><span className="font-medium text-foreground">Remove:</span> {changes.removed.join(", ")}</p>}
      <p>The server restarts and downloads them.{server.playersOnline ? ` ${server.playersOnline} player${server.playersOnline === 1 ? " is" : "s are"} online and will be disconnected after a ${server.stopAnnounceDelaySeconds}s warning.` : ""} {target.kind === "plugin" ? "Plugins" : "Mods"} run code on your server, so only add ones you trust.</p>
      {openingPorts.map((preset) => <p key={preset.id} className="rounded-lg border border-border p-2.5">{preset.label} needs port {preset.target}{preset.protocol === "udp" ? " (UDP)" : ""}{preset.sameNumber ? "" : " or a free one near it"}; it&apos;s opened with this restart. {preset.setup(target.kind === "mod")}</p>)}
      <p>A safety backup is taken first, and if the server doesn&apos;t start, the previous setup is restored automatically.</p>
    </ConfirmDialog>
  </div>;
}
