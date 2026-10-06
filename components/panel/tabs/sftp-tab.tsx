"use client";

import { useCallback, useEffect, useState } from "react";
import { Dices, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog, Section } from "../common";
import { api, errorMessage, formatRelative } from "../lib";
import { useNow } from "../panel-context";
import { CopyValue, sftpHost, type SftpInfo } from "../sftp-access";
import type { MinecraftServer } from "../types";

type ServerSftp = SftpInfo & { username: string; password: string; createdAt: number; lastUsedAt: number | null };

/** How to open this server's files in an SFTP app, with its own password (made on first look). */
export function SftpTab({ server }: { server: MinecraftServer }) {
  const now = useNow(60_000);
  const [data, setData] = useState<ServerSftp | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api<ServerSftp>(`/api/servers/${server.id}/sftp`)); setError(""); }
    catch (reason) { setError(errorMessage(reason, "Couldn't load SFTP details.")); }
  }, [server.id]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function reroll() {
    setBusy(true);
    try { setData(await api<ServerSftp>(`/api/servers/${server.id}/sftp`, { method: "POST" })); toast.success("New SFTP password made. Apps using the old one are disconnected."); }
    catch (reason) { toast.error(errorMessage(reason, "Couldn't make a new password.")); }
    finally { setBusy(false); }
  }

  if (error) return <p className="rounded-xl border border-destructive/30 bg-danger-soft p-4 text-sm text-destructive">{error}</p>;
  if (!data) return <Skeleton className="h-64" />;
  const host = sftpHost();
  return <div className="space-y-5">
    <Section title="Connect with SFTP" description={`Open ${server.name}'s files in FileZilla, WinSCP, Cyberduck, or any SFTP app. You land in its data folder and can't leave it.`}
      actions={<Button size="sm" variant="outline" onClick={() => setConfirming(true)} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Dices />}Re-roll password</Button>}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <dl className="rounded-lg border border-border px-3">
            <CopyValue label="Host" value={host} />
            <CopyValue label="Port" value={String(data.port)} />
            <CopyValue label="Username" value={data.username} />
            <CopyValue label="Password" value={data.password} secret />
            {data.fingerprint && <CopyValue label="Host key" value={data.fingerprint} />}
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">Password made {formatRelative(new Date(data.createdAt).toISOString(), now)} · {data.lastUsedAt ? `last used ${formatRelative(new Date(data.lastUsedAt).toISOString(), now)}` : "not used yet"}</p>
        </div>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground">FileZilla:</span> File → Site Manager → New site. Choose SFTP, then paste the host, port, username, and password. WinSCP and Cyberduck ask for the same four.</p>
          <p><span className="font-medium text-foreground">Command line:</span> <code className="font-mono text-xs text-foreground">sftp -P {data.port} {data.username}@{host}</code></p>
          <p>On first connect, check that the host key your app shows matches the one here.</p>
          <p>This password only opens {server.name}, and only for you. Your account password doesn&apos;t work for SFTP: an SFTP app can&apos;t ask for a two-factor code. Changing your account password replaces this one too.</p>
        </div>
      </div>
    </Section>
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Make a new SFTP password?" confirmLabel="Re-roll password" onConfirm={() => void reroll()}>
      <p>The current password stops working right away, and apps signed in with it are disconnected within a few seconds. Paste the new one into your SFTP app afterwards.</p>
    </ConfirmDialog>
  </div>;
}
