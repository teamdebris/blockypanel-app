"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Eye, EyeOff, Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { serverHref } from "./lib";
import { usePanel } from "./panel-context";
import type { MinecraftServer } from "./types";

export type SftpInfo = { enabled: boolean; port?: number; fingerprint?: string };

/** The machine's name as the browser reached it; SFTP runs on the same machine as the panel. */
export function sftpHost() {
  return typeof window === "undefined" ? "localhost" : window.location.hostname;
}

/** One row of connection details with a copy button; a secret stays hidden until Show. */
export function CopyValue({ label, value, mono = true, secret = false }: { label: string; value: string; mono?: boolean; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { toast.error("Couldn't copy. Select it and copy it manually."); }
  }
  return <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
    <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
    <dd className="flex min-w-0 items-center gap-1"><span className={cn("truncate text-sm", mono && "font-mono text-xs")} title={shown ? value : undefined}>{shown ? value : "•".repeat(16)}</span>
      {secret && <Button type="button" variant="ghost" size="icon-xs" aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? <EyeOff /> : <Eye />}</Button>}
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button></dd>
  </div>;
}

/** The Files tab's SFTP button: opens the server's SFTP tab. */
export function SftpConnectButton({ server }: { server: MinecraftServer }) {
  const { system, me } = usePanel();
  if (!system?.sftp?.enabled || !me?.username || me.recovery || me.demo) return null;
  return <Button size="sm" variant="outline" asChild><Link href={serverHref(server.id, "sftp")}><Plug />SFTP</Link></Button>;
}
