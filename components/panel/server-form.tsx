"use client";

import { useEffect, useState } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Field } from "./common";
import { javaVersions, memoryOptions, moddedTypes, serverTypes } from "./lib";
import type { Difficulty, JavaVersion, MinecraftServer, NumericFormKey, ServerForm, ServerType } from "./types";

export type FieldErrors = Partial<Record<keyof ServerForm, string>>;

let versionCache: Promise<string[]> | undefined;
function useMinecraftVersions() {
  const [versions, setVersions] = useState<string[]>([]);
  useEffect(() => {
    versionCache ??= fetch("/api/versions").then((response) => response.json()).then((body: { versions?: string[] }) => body.versions || []).catch(() => []);
    let active = true;
    void versionCache.then((list) => { if (active) setVersions(list); });
    return () => { active = false; };
  }, []);
  return versions;
}

/** Client-side checks that mirror the server's validation, so problems show on the field right away. */
export function validateForm(form: ServerForm, servers: MinecraftServer[], selfId?: string): FieldErrors {
  const errors: FieldErrors = {};
  if (form.name.trim().length < 2) errors.name = "Use at least 2 characters.";
  if (!/^[a-zA-Z0-9._-]+$/.test(form.version.trim())) errors.version = "Use a version like 1.21.8, or LATEST.";
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.port = "Choose a port between 1024 and 65535.";
  else if (servers.some((server) => server.id !== selfId && server.port === port)) errors.port = `Port ${port} is already used by ${servers.find((server) => server.port === port)?.name}.`;
  const players = Number(form.maxPlayers);
  if (!Number.isInteger(players) || players < 1 || players > 500) errors.maxPlayers = "Between 1 and 500.";
  if (!form.motd.trim()) errors.motd = "Enter a message players see in the server list.";
  const invalidName = form.whitelist.split(/[\n,]/).map((item) => item.trim()).filter(Boolean).find((item) => !/^[a-zA-Z0-9_-]+$/.test(item));
  if (invalidName) errors.whitelist = `"${invalidName}" isn't a valid username.`;
  const badLine = form.customProperties.split("\n").find((line) => line.trim() && !line.includes("="));
  if (badLine) errors.customProperties = `Use key=value on each line ("${badLine.trim().slice(0, 30)}").`;
  const cpu = Number(form.cpuLimit || 0);
  if (Number.isNaN(cpu) || cpu < 0 || cpu > 64) errors.cpuLimit = "Between 0 (unlimited) and 64 cores.";
  if (Number(form.simulationDistance) > Number(form.viewDistance)) errors.simulationDistance = "Can't be larger than the view distance.";
  if (Number(form.initialMemoryPercent) > Number(form.maxMemoryPercent)) errors.initialMemoryPercent = "Can't exceed the maximum heap.";
  return errors;
}

function Collapsible({ title, description, children, defaultOpen = false }: { title: string; description?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return <details className="group rounded-xl border border-border bg-card open:bg-card sm:col-span-2" open={defaultOpen}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <span><span className="block text-sm font-medium">{title}</span>{description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}</span>
      <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-5 border-t border-border p-4 sm:grid-cols-2">{children}</div>
  </details>;
}

type FormProps = { form: ServerForm; setForm: (value: ServerForm) => void; errors: FieldErrors; idPrefix: string; servers: MinecraftServer[] };

export function BasicFields({ form, setForm, errors, idPrefix, creating = false }: FormProps & { creating?: boolean }) {
  const versions = useMinecraftVersions();
  const id = (name: string) => `${idPrefix}-${name}`;
  const memoryChoices = memoryOptions.includes(form.memory) ? memoryOptions : [form.memory, ...memoryOptions];
  return <>
    <Field label="Server name" id={id("name")} wide error={errors.name}>{(props) => <Input {...props} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required minLength={2} maxLength={60} autoComplete="off" placeholder="Survival with friends" />}</Field>
    {creating ? <fieldset className="sm:col-span-2">
      <legend className="mb-2 text-sm font-medium">Server type</legend>
      <div className="grid grid-cols-2 gap-2">
        {serverTypes.map((type) => <label key={type.value} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-sm transition-colors sm:gap-3 sm:p-3", form.type === type.value ? "border-foreground/40 bg-accent" : "border-border hover:bg-muted/60")}>
          <input type="radio" name={id("type")} value={type.value} checked={form.type === type.value} onChange={() => setForm({ ...form, type: type.value as ServerType })} className="mt-0.5 accent-current" />
          <span><span className="block font-medium">{type.label}</span><span className="block text-xs text-muted-foreground">{type.description}</span></span>
        </label>)}
      </div>
    </fieldset> : <Field label="Server type" id={id("type")} hint="Changing the type on an existing world can break it. A safety backup is taken first.">
      {(props) => <Select value={form.type} onValueChange={(type: ServerType) => setForm({ ...form, type })}><SelectTrigger {...props} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{serverTypes.map((type) => <SelectItem key={type.value} value={type.value}>{type.label} · {type.description}</SelectItem>)}</SelectContent></Select>}
    </Field>}
    <Field label="Minecraft version" id={id("version")} error={errors.version} hint={moddedTypes.has(form.type) ? "Pick the version your mods are built for." : "LATEST follows new releases automatically."}>
      {(props) => <><Input {...props} list={id("versions")} value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} required autoComplete="off" autoCapitalize="off" spellCheck={false} />
        <datalist id={id("versions")}><option value="LATEST">Latest release</option>{versions.map((version) => <option key={version} value={version} />)}</datalist></>}
    </Field>
    <Field label="Memory" id={id("memory")} hint="Total RAM the server may use.">
      {(props) => <Select value={form.memory} onValueChange={(memory) => setForm({ ...form, memory })}><SelectTrigger {...props} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{memoryChoices.map((value) => <SelectItem value={value} key={value}>{value.replace("G", " GB")}</SelectItem>)}</SelectContent></Select>}
    </Field>
    <Field label="Difficulty" id={id("difficulty")}>
      {(props) => <Select value={form.difficulty} onValueChange={(difficulty: Difficulty) => setForm({ ...form, difficulty })}><SelectTrigger {...props} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["peaceful", "easy", "normal", "hard"].map((value) => <SelectItem value={value} key={value}>{value[0].toUpperCase() + value.slice(1)}</SelectItem>)}</SelectContent></Select>}
    </Field>
    <Field label="Max players" id={id("players")} error={errors.maxPlayers}>{(props) => <Input {...props} type="number" inputMode="numeric" min={1} max={500} value={form.maxPlayers} onChange={(event) => setForm({ ...form, maxPlayers: event.target.value })} required />}</Field>
    <Field label="Message of the day" id={id("motd")} wide error={errors.motd} hint="Shown under the server name in the multiplayer list.">{(props) => <Input {...props} value={form.motd} onChange={(event) => setForm({ ...form, motd: event.target.value })} required maxLength={160} />}</Field>
  </>;
}

export function AdvancedFields({ form, setForm, errors, idPrefix, creating = false }: FormProps & { creating?: boolean }) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return <Collapsible title="Advanced" description="Port, Java, CPU limit, whitelist, world seed, and custom server.properties" defaultOpen={Boolean(errors.port || errors.whitelist || errors.customProperties || errors.cpuLimit)}>
    <Field label="Port" id={id("port")} error={errors.port} hint="Players add this to the address. 25565 is the Minecraft default.">{(props) => <Input {...props} type="number" inputMode="numeric" min={1024} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} required />}</Field>
    <Field label="Java runtime" id={id("java")} hint={form.javaVersion === "8" || form.javaVersion === "11" ? "Older Java: use for Minecraft 1.16 and earlier." : "Automatic picks a Java that suits recent versions."}>
      {(props) => <Select value={form.javaVersion} onValueChange={(javaVersion: JavaVersion) => setForm({ ...form, javaVersion })}><SelectTrigger {...props} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{javaVersions.map((item) => <SelectItem value={item.value} key={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>}
    </Field>
    <Field label="CPU limit" id={id("cpu")} error={errors.cpuLimit} hint="Cores this server may use; 0 means no limit.">{(props) => <Input {...props} type="number" min={0} max={64} step={0.25} value={form.cpuLimit} onChange={(event) => setForm({ ...form, cpuLimit: event.target.value })} />}</Field>
    <Field label="World seed" id={id("seed")} hint={creating ? "Leave empty for a random world." : "Only used when a new world is generated."}>{(props) => <Input {...props} value={form.seed} onChange={(event) => setForm({ ...form, seed: event.target.value })} autoComplete="off" />}</Field>
    <Field label="Whitelist" id={id("whitelist")} wide error={errors.whitelist} hint="One username per line. When set, only these players can join.">{(props) => <Textarea {...props} rows={3} value={form.whitelist} onChange={(event) => setForm({ ...form, whitelist: event.target.value })} placeholder={"Steve\nAlex"} autoCapitalize="off" spellCheck={false} />}</Field>
    <Field label="Custom server.properties" id={id("properties")} wide error={errors.customProperties} hint="One key=value per line, e.g. spawn-protection=0. These survive restarts, unlike editing the file directly.">{(props) => <Textarea {...props} className="font-mono text-xs" rows={4} value={form.customProperties} onChange={(event) => setForm({ ...form, customProperties: event.target.value })} placeholder="spawn-protection=0" autoCapitalize="off" spellCheck={false} />}</Field>
  </Collapsible>;
}

const performancePresets = {
  low: { label: "Low resource", values: { initialMemoryPercent: "20", maxMemoryPercent: "70", rollingLogMaxFiles: "14", viewDistance: "6", simulationDistance: "4", stopAnnounceDelaySeconds: "10", pauseWhenEmptySeconds: "300", useMeowiceFlags: true } },
  balanced: { label: "Balanced", values: { initialMemoryPercent: "25", maxMemoryPercent: "75", rollingLogMaxFiles: "30", viewDistance: "8", simulationDistance: "6", stopAnnounceDelaySeconds: "10", pauseWhenEmptySeconds: "300", useMeowiceFlags: true } },
  distance: { label: "High distance", values: { initialMemoryPercent: "25", maxMemoryPercent: "75", rollingLogMaxFiles: "30", viewDistance: "12", simulationDistance: "8", stopAnnounceDelaySeconds: "10", pauseWhenEmptySeconds: "-1", useMeowiceFlags: true } },
} as const;

function selectedPreset(form: ServerForm) {
  return (Object.entries(performancePresets).find(([, preset]) => Object.entries(preset.values).every(([key, value]) => form[key as keyof ServerForm] === value))?.[0] || "custom") as keyof typeof performancePresets | "custom";
}

function memoryGb(memory: string, percent: string) {
  const total = Number(memory.replace(/[^\d]/g, "")) * (memory.toUpperCase().endsWith("M") ? 1 / 1024 : 1);
  return `${((total * Number(percent)) / 100).toFixed(1)} GB of ${total} GB`;
}

export function PerformanceFields({ form, setForm, errors, idPrefix }: FormProps) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const setNumber = (key: NumericFormKey, value: string) => setForm({ ...form, [key]: value });
  const pauseEnabled = form.pauseWhenEmptySeconds !== "-1";
  const oldJava = form.javaVersion === "8" || form.javaVersion === "11";
  return <>
    <div className="field sm:col-span-2">
      <Label htmlFor={id("preset")}>Performance preset</Label>
      <Select value={selectedPreset(form)} onValueChange={(value) => value !== "custom" && setForm({ ...form, ...performancePresets[value as keyof typeof performancePresets].values })}>
        <SelectTrigger id={id("preset")} className="w-full sm:w-60"><SelectValue /></SelectTrigger>
        <SelectContent>{Object.entries(performancePresets).map(([key, preset]) => <SelectItem key={key} value={key}>{preset.label}</SelectItem>)}<SelectItem value="custom" disabled>Custom</SelectItem></SelectContent>
      </Select>
    </div>
    <Field label="View distance" id={id("view")} hint="Chunks sent to players. Affects bandwidth and memory.">{(props) => <Input {...props} type="number" min={2} max={32} value={form.viewDistance} onChange={(event) => setNumber("viewDistance", event.target.value)} />}</Field>
    <Field label="Simulation distance" id={id("simulation")} error={errors.simulationDistance} hint="Chunks where crops grow and mobs move. Affects CPU the most.">{(props) => <Input {...props} type="number" min={2} max={32} value={form.simulationDistance} onChange={(event) => setNumber("simulationDistance", event.target.value)} />}</Field>
    <div className="field sm:col-span-2">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
        <Label htmlFor={id("pause")} className="flex-1 flex-col items-start gap-0.5 font-normal leading-5"><span className="block font-medium">Pause when nobody is online</span><span className="block text-xs text-muted-foreground">Saves CPU while the server is empty. Requires Minecraft 1.21.2 or newer.</span></Label>
        <Switch id={id("pause")} checked={pauseEnabled} onCheckedChange={(checked) => setForm({ ...form, pauseWhenEmptySeconds: checked ? "300" : "-1" })} />
      </div>
      {pauseEnabled && <div className="flex items-center gap-2 text-sm"><Label htmlFor={id("pause-seconds")} className="font-normal text-muted-foreground">After</Label><Input id={id("pause-seconds")} type="number" min={0} max={86400} value={form.pauseWhenEmptySeconds} onChange={(event) => setNumber("pauseWhenEmptySeconds", event.target.value)} className="h-8 w-24" /><span className="text-muted-foreground">seconds</span></div>}
    </div>
    <Field label="Shutdown warning" id={id("stop-delay")} hint="Seconds players get a warning before a stop or restart.">{(props) => <Input {...props} type="number" min={0} max={300} value={form.stopAnnounceDelaySeconds} onChange={(event) => setNumber("stopAnnounceDelaySeconds", event.target.value)} />}</Field>
    <Collapsible title="Advanced (Java)" description="Memory split, JVM flags, and log retention" defaultOpen={Boolean(errors.initialMemoryPercent)}>
      <Field label="Initial heap" id={id("initial-memory")} error={errors.initialMemoryPercent} hint={`${form.initialMemoryPercent}% → ${memoryGb(form.memory, form.initialMemoryPercent)}`}>{(props) => <Input {...props} type="number" min={5} max={90} value={form.initialMemoryPercent} onChange={(event) => setNumber("initialMemoryPercent", event.target.value)} />}</Field>
      <Field label="Maximum heap" id={id("max-memory")} hint={`${form.maxMemoryPercent}% → ${memoryGb(form.memory, form.maxMemoryPercent)}. Leave about 25% for Java itself.`}>{(props) => <Input {...props} type="number" min={25} max={90} value={form.maxMemoryPercent} onChange={(event) => setNumber("maxMemoryPercent", event.target.value)} />}</Field>
      <Field label="Log files kept" id={id("logs")} hint="Older compressed logs are deleted first.">{(props) => <Input {...props} type="number" min={1} max={1000} value={form.rollingLogMaxFiles} onChange={(event) => setNumber("rollingLogMaxFiles", event.target.value)} />}</Field>
      <div className="field">
        <div className="flex min-h-9 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
          <Label htmlFor={id("meowice")} className="flex-1 flex-col items-start gap-0.5 font-normal leading-5"><span className="block font-medium">Optimized JVM flags</span><span className="block text-xs text-muted-foreground">Recommended. Needs Java 17 or newer.</span></Label>
          <Switch id={id("meowice")} checked={form.useMeowiceFlags} onCheckedChange={(checked) => setForm({ ...form, useMeowiceFlags: checked })} />
        </div>
        {form.useMeowiceFlags && oldJava && <p className="flex items-center gap-1.5 text-xs text-warning"><TriangleAlert className="size-3.5" />Java {form.javaVersion} doesn&apos;t support these flags. Turn them off.</p>}
      </div>
    </Collapsible>
  </>;
}
